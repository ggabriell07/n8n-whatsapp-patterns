# n8n-whatsapp-patterns

Padrões práticos para integração de n8n com WhatsApp via Evolution API desenvolvidos e validados em produção.

A documentação cobre os três problemas mais difíceis dessa stack que não têm solução clara em português: descriptografia de mídia, roteamento de intenção por LLM e gestão de estado de conversa multi-step.

---

## Ambiente

```
n8n self-hosted
Evolution API v2.3.7 (Baileys)
Node.js via nó Code do n8n
```

Variáveis de ambiente obrigatórias no n8n:
```
NODE_FUNCTION_ALLOW_ALLOW_BUILTIN=crypto,https,http
N8N_RUNNERS_DISABLED=true
```

Sem essas variáveis os módulos `crypto`, `https` e `http` do Node.js ficam inacessíveis nos nós Code, e boa parte dos padrões abaixo não funciona.

---

## Padrão 1 — Descriptografia de mídia (áudio e imagem)

### O problema

A Evolution API entrega mensagens de mídia com o conteúdo **criptografado**. O endpoint oficial `/chat/getBase64FromMediaMessage` nem sempre está disponível dependendo da versão e do ambiente. A solução é descriptografar manualmente usando a chave e o IV que vêm no próprio payload da mensagem.

O WhatsApp usa **HKDF (HMAC-based Key Derivation Function)** para derivar a chave de descriptografia a partir de uma `mediaKey` em base64.

### Payload relevante que chega no webhook

```json
{
  "message": {
    "audioMessage": {
      "url": "https://mmg.whatsapp.net/...",
      "mimetype": "audio/ogg; codecs=opus",
      "mediaKey": "BASE64_DA_CHAVE",
      "fileEncSha256": "BASE64_HASH",
      "fileSha256": "BASE64_HASH",
      "fileLength": 12345,
      "directPath": "/v/..."
    }
  }
}
```

Para imagem, o campo é `imageMessage` com a mesma estrutura.

### Implementação no nó Code do n8n

```javascript
const crypto = require('crypto');
const https = require('https');

// 1. Extrair dados do payload
const msg = $input.first().json;
const mediaMsg = msg.message?.audioMessage || msg.message?.imageMessage;

const mediaKeyB64 = mediaMsg.mediaKey;
const mediaUrl = mediaMsg.url;
const mimetype = mediaMsg.mimetype;

// 2. Derivar chave via HKDF
// O info string muda conforme o tipo de mídia:
// áudio   → "WhatsApp Audio Keys"
// imagem  → "WhatsApp Image Keys"
// vídeo   → "WhatsApp Video Keys"
// doc     → "WhatsApp Document Keys"
const mediaType = msg.message?.audioMessage ? 'Audio' : 'Image';
const info = `WhatsApp ${mediaType} Keys`;

const mediaKey = Buffer.from(mediaKeyB64, 'base64');

// HKDF-Extract (SHA-256, salt nulo)
const salt = Buffer.alloc(32, 0);
const prk = crypto.createHmac('sha256', salt).update(mediaKey).digest();

// HKDF-Expand — gera 112 bytes
function hkdfExpand(prk, info, length) {
  const blocks = [];
  let prev = Buffer.alloc(0);
  let i = 1;
  while (blocks.reduce((a, b) => a + b.length, 0) < length) {
    const hmac = crypto.createHmac('sha256', prk);
    hmac.update(prev);
    hmac.update(Buffer.from(info));
    hmac.update(Buffer.from([i++]));
    prev = hmac.digest();
    blocks.push(prev);
  }
  return Buffer.concat(blocks).slice(0, length);
}

const expanded = hkdfExpand(prk, info, 112);
const iv  = expanded.slice(0,  16);  // primeiros 16 bytes
const key = expanded.slice(16, 48);  // próximos  32 bytes
// expanded.slice(48, 80) → macKey (não usado aqui)
// expanded.slice(80)     → refKey  (não usado aqui)

// 3. Baixar arquivo criptografado
function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });
}

const encryptedBuffer = await download(mediaUrl);

// 4. Remover os últimos 10 bytes (MAC do WhatsApp)
const ciphertext = encryptedBuffer.slice(0, encryptedBuffer.length - 10);

// 5. Descriptografar AES-256-CBC
const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

// 6. Retornar base64 para uso no próximo nó
const base64 = decrypted.toString('base64');

return [{ json: { ...msg, mediaBase64: base64, mediaMimetype: mimetype } }];
```

### Para áudio: enviar para Whisper

```javascript
// Nó seguinte após descriptografia
const FormData = require('form-data'); // não disponível no n8n — use HTTP Request configurado

// Alternativa funcional: enviar base64 direto para a API da OpenAI
// via nó HTTP Request com Binary Input habilitado
```

Para áudio, a saída `mediaBase64` vai para um nó **HTTP Request** configurado para a API do Whisper (`POST https://api.openai.com/v1/audio/transcriptions`) com o arquivo em multipart/form-data.

---

## Padrão 2 — Roteamento de intenção via LLM

### O problema

O usuário manda mensagens em linguagem natural. Em vez de regex ou palavras-chave frágeis, usar o LLM para classificar a intenção e rotear para o fluxo correto.

### Estrutura do nó de detecção

```javascript
const ctx = $input.first().json;

const systemPrompt = `Você é um classificador de intenção. 
Analise a mensagem e retorne SOMENTE um JSON com o campo "intent".

Valores possíveis para intent:
- "expense"      → registro de gasto ou despesa
- "income"       → registro de receita ou recebimento  
- "purchase"     → dúvida sobre fazer uma compra
- "report"       → pedido de relatório ou resumo
- "help"         → dúvida sobre funcionalidades
- "onboarding"   → usuário novo ou configuração
- "unknown"      → nada dos anteriores

Retorne apenas o JSON, sem explicação. Exemplo: {"intent": "expense"}`;

return [{ json: { ...ctx, intentPrompt: systemPrompt } }];
```

O nó HTTP Request chama a Claude API e o nó seguinte extrai o intent:

```javascript
const response = $input.first().json;
const content = response.content[0].text;

let intent = 'unknown';
try {
  const parsed = JSON.parse(content);
  intent = parsed.intent || 'unknown';
} catch {
  // fallback seguro
}

return [{ json: { ...$input.first().json, intent } }];
```

### Roteamento com nó Switch

No nó **Switch** do n8n, configure uma regra por valor de `intent`:

| Condição | Valor | Conecta em |
|---|---|---|
| `intent` equals | `expense` | Fluxo Gasto |
| `intent` equals | `income` | Fluxo Receita |
| `intent` equals | `purchase` | Fluxo Análise Compra |
| `intent` equals | `report` | Fluxo Relatório |
| `intent` equals | `help` | Fluxo Ajuda |
| fallback | — | Fluxo Desconhecido |

---

## Padrão 3 — Estado de conversa multi-step

### O problema

WhatsApp não tem sessão nativa. Cada mensagem é um webhook independente. Para fluxos que precisam de múltiplas respostas (onboarding, análise de compra com 5 perguntas), é preciso persistir o estado entre mensagens.

### Estrutura no banco (Supabase / PostgreSQL)

```sql
-- Campos relevantes na tabela users
flow_active    TEXT     -- nome do fluxo em andamento (ex: 'onboarding', 'purchase_analysis')
flow_step      INTEGER  -- etapa atual dentro do fluxo
flow_data      JSONB    -- dados coletados nas etapas anteriores
```

### Lógica no nó Code

```javascript
const ctx = $input.first().json;

// ctx vem do SELECT do Supabase com os dados do usuário
const flowActive = ctx.flow_active;
const flowStep   = ctx.flow_step || 1;
const flowData   = ctx.flow_data || {};
const text       = ctx.text?.trim();

let reply = '';
let nextStep = flowStep;
let newFlowData = { ...flowData };
let finishFlow = false;

if (flowActive === 'onboarding') {
  if (flowStep === 1) {
    reply = 'Qual é o seu nome?';
    nextStep = 2;
  } else if (flowStep === 2) {
    newFlowData.name = text;
    reply = `Prazer, ${text}! Qual é sua renda mensal aproximada?`;
    nextStep = 3;
  } else if (flowStep === 3) {
    newFlowData.monthly_income = parseFloat(
      text.replace(/mil/gi, '000').replace(/[^0-9,.]/g, '').replace(',', '.')
    ) || null;
    reply = 'E qual o limite máximo de gastos por mês?';
    nextStep = 4;
  } else if (flowStep === 4) {
    newFlowData.monthly_limit = parseFloat(
      text.replace(/mil/gi, '000').replace(/[^0-9,.]/g, '').replace(',', '.')
    ) || null;
    finishFlow = true;
    reply = 'Tudo configurado! Pode começar a registrar seus gastos.';
  }
}

return [{
  json: {
    ...ctx,
    reply,
    nextFlowStep: nextStep,
    newFlowData,
    finishFlow
  }
}];
```

### UPDATE no Supabase após cada etapa

```sql
UPDATE users
SET
  flow_step = {{ $json.nextFlowStep }},
  flow_data = {{ JSON.stringify($json.newFlowData) }},
  flow_active = CASE WHEN {{ $json.finishFlow }} THEN NULL ELSE flow_active END
WHERE phone = '{{ $json.phone }}'
```

---

## Padrão 4 — Histórico de conversa como contexto do LLM

### O problema

LLMs não têm memória entre chamadas. Para manter coerência conversacional, é preciso enviar as mensagens anteriores como contexto em cada requisição.

### Estrutura no banco

```sql
-- Campo JSONB na tabela users
recent_messages JSONB DEFAULT '[]'::jsonb

-- Estrutura do array
[
  { "role": "user",      "content": "gastei 50 no almoço" },
  { "role": "assistant", "content": "Anotado! R$ 50,00 no almoço..." },
  { "role": "user",      "content": "e ontem gastei 30 no transporte" }
]
```

### Uso no prompt

```javascript
const ctx = $input.first().json;
const history = ctx.recent_messages || [];

// Monta messages para a API
const messages = [
  ...history.slice(-6), // últimas 6 trocas = 3 do usuário + 3 do bot
  { role: 'user', content: ctx.text }
];

return [{ json: { ...ctx, messages } }];
```

### Atualização após resposta

```javascript
const ctx = $input.first().json;
const reply = ctx.reply;
const history = ctx.recent_messages || [];

const updated = [
  ...history,
  { role: 'user',      content: ctx.text  },
  { role: 'assistant', content: reply     }
].slice(-20); // mantém só as últimas 20 mensagens

return [{ json: { ...ctx, updatedHistory: JSON.stringify(updated) } }];
```

---

## Estrutura recomendada de fluxo completo

```
[Webhook Evolution API]
    ↓
[Valida acesso] → Supabase SELECT users WHERE phone = X
    ↓
[Normaliza entrada] → extrai text/áudio/imagem, phone, messageId
    ↓
[Processa mídia?] → se áudio: HKDF → Whisper
                  → se imagem: HKDF → Claude Vision
    ↓
[Fluxo ativo?] → se sim: continua fluxo multi-step
               → se não: detecta intenção via LLM
    ↓
[Switch por intent]
    ├── expense   → [Extrai dados] → [Salva] → [Monta reply]
    ├── income    → [Extrai dados] → [Salva] → [Monta reply]
    ├── purchase  → [Inicia fluxo] → [Salva estado]
    ├── report    → [Agrega dados] → [Gera análise] → [Monta reply]
    └── help      → [Reply estático]
    ↓
[Atualiza histórico] → Supabase UPDATE recent_messages
    ↓
[Envia resposta] → Evolution API POST /message/sendText
```

---

## Observações de produção

**Deduplicação de mensagens:** o Evolution API pode entregar o mesmo webhook mais de uma vez. Persista o `messageId` e ignore duplicatas.

**Timeout:** nós com LLM podem demorar 3–8 segundos. Configure o timeout do webhook do n8n adequadamente (`WEBHOOK_TIMEOUT` no `.env`).

**Mensagens de grupo:** a Evolution API entrega mensagens de grupo pelo mesmo webhook. Filtre por `key.remoteJid` — mensagens de grupo terminam em `@g.us`, individuais em `@s.whatsapp.net`.

```javascript
const remoteJid = $input.first().json.key?.remoteJid || '';
if (remoteJid.endsWith('@g.us')) return []; // ignora grupos
```

---

## Referências

- [Evolution API Docs](https://doc.evolution-api.com)
- [n8n Code Node](https://docs.n8n.io/code/code-node/)
- [WhatsApp Key Derivation — Baileys source](https://github.com/WhiskeySockets/Baileys)
- [HKDF RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)
