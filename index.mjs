import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { MongoClient, ObjectId } from "mongodb";
import OpenAI from "openai";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT || "3001", 10);
const MONGODB_URI  = process.env.MONGODB_URI;
const MONGODB_DB   = process.env.MONGODB_DB  || "lia-dev";
const AUTH_TOKEN   = process.env.MCP_AUTH_TOKEN; // opcional

if (!MONGODB_URI)                throw new Error("MONGODB_URI env var é obrigatória");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY env var é obrigatória");

// ── Clientes externos ─────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let mongoClient = null;

async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    await mongoClient.connect();
    console.log(`[mongo] Conectado ao banco: ${MONGODB_DB}`);
  }
  return mongoClient.db(MONGODB_DB);
}

// ── System Prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt({ clinicName, clinicDescription, services, businessHours, clientName, todayStr, todayISO }) {
  const base        = clinicDescription || "Você é uma atendente de clínica estética.";
  const servicesStr = services?.length ? `Serviços oferecidos: ${services.join(", ")}` : "";
  const hoursStr    = businessHours    ? `Horários de funcionamento: ${JSON.stringify(businessHours)}` : "";

  return `${base}

Você é a atendente virtual da clínica ${clinicName}.
O cliente se chama ${clientName}.
Hoje é ${todayStr} (ISO: ${todayISO}).
${servicesStr}
${hoursStr}

━━━ REGRAS DE ATENDIMENTO ━━━
- Responda exatamente ao que o cliente perguntou
- Seja natural, educada e objetiva
- NÃO dê respostas genéricas
- Use no máximo 2 frases na resposta para o cliente

━━━ CLASSIFICAÇÃO DO CLIENTE ━━━
- "novo": primeiro contato, sem intenção definida
- "atendimento": perguntando sobre serviços, preços ou procedimentos
- "agendado": confirmou data, horário e procedimento — agendamento criado
- "parado": conversa encerrada ou sem resposta

━━━ CRIAÇÃO DE AGENDAMENTO ━━━
Inclua o campo "appointment" SOMENTE quando TODAS estas condições forem verdadeiras:
  1. O cliente confirmou explicitamente que quer agendar
  2. Data E horário foram definidos na conversa
  3. O procedimento foi identificado

- "date": formato "YYYY-MM-DD" (resolva datas relativas usando a data de hoje)
- "time": formato "HH:MM"
- "procedure": obrigatório
- "professional" e "notes": opcionais
- Quando criar appointment, defina clientStatus como "agendado"
- NÃO inclua o campo se não for agendar

━━━ FORMATO DA RESPOSTA ━━━
Responda SOMENTE com JSON válido. Nada fora do JSON.

Sem agendamento:
{"reply":"...","clientStatus":"atendimento","activitySummary":"${clientName} perguntou sobre..."}

Com agendamento (quando o cliente confirmou tudo):
{"reply":"...","clientStatus":"agendado","activitySummary":"${clientName} agendou...","appointment":{"date":"YYYY-MM-DD","time":"HH:MM","procedure":"...","professional":"Dra. Fulana"}}`;
}

// ── Lógica de Negócio ─────────────────────────────────────────────────────────

/**
 * Processa uma mensagem do WhatsApp:
 * 1. Identifica a clínica pelo número de telefone
 * 2. Busca histórico do cliente
 * 3. Chama Claude com contexto + histórico
 * 4. Salva cliente/mensagens/agendamento no MongoDB
 * 5. Retorna a resposta estruturada
 */
async function handleMessage({ waId, clientName, message, clinicPhone }) {
  const db = await getDb();

  // 1. Identificar clínica pelo número
  const cleanPhone = clinicPhone.replace(/\D/g, "");
  const clinic = await db.collection("clinics").findOne({ "whatsapp.number": cleanPhone });
  if (!clinic) throw new Error(`Clínica não encontrada para o número: ${cleanPhone}`);

  const clinicIdStr = clinic._id.toString();
  const clinicId    = clinic._id;

  // 2. Buscar config da clínica + histórico do cliente (em paralelo)
  const [config, clientDoc] = await Promise.all([
    db.collection("clinicConfig").findOne({ clinicId: clinicIdStr }),
    db.collection("clients").findOne(
      { waId, clinicId },
      { projection: { messages: { $slice: -10 } } }
    ),
  ]);

  const services = config?.procedures?.map(p => p.name)
    ?? config?.services
    ?? [];
  const history = clientDoc?.messages ?? [];

  // 3. Montar o prompt e o histórico de conversa
  const todayISO = new Date().toISOString().slice(0, 10);
  const todayStr = new Date().toLocaleDateString("pt-BR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const systemPrompt = buildSystemPrompt({
    clinicName:       clinic.name,
    clinicDescription: config?.description ?? null,
    services,
    businessHours:    config?.schedule ?? config?.businessHours ?? null,
    clientName,
    todayStr,
    todayISO,
  });

  const conversationMessages = [
    ...history.map(m => ({
      role:    m.from === "client" ? "user" : "assistant",
      content: m.text,
    })),
    { role: "user", content: message },
  ];

  // 4. Chamar OpenAI
  const aiResp = await openai.chat.completions.create({
    model:           "gpt-4o-mini",
    response_format: { type: "json_object" },
    max_tokens:      600,
    messages: [
      { role: "system", content: systemPrompt },
      ...conversationMessages,
    ],
  });

  const raw = aiResp.choices[0]?.message?.content;
  if (!raw) throw new Error("Resposta vazia da IA");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`IA retornou JSON inválido: ${raw}`);
  }

  if (!parsed.reply || !parsed.clientStatus || !parsed.activitySummary) {
    throw new Error(`Resposta da IA incompleta: ${JSON.stringify(parsed)}`);
  }

  // Descartar appointment incompleto
  if (parsed.appointment) {
    const { date, time, procedure } = parsed.appointment;
    if (!date || !time || !procedure) {
      console.warn("[handleMessage] appointment descartado (campos faltando):", parsed.appointment);
      delete parsed.appointment;
    }
  }

  // 5. Persistir no MongoDB
  const now       = new Date();
  const clientMsg = { from: "client", text: message,       createdAt: now.toISOString() };
  const iaMsg     = { from: "ia",     text: parsed.reply,  createdAt: new Date(now.getTime() + 1).toISOString() };

  let appointmentId = null;
  if (parsed.appointment) {
    const { date, time, procedure, professional, notes } = parsed.appointment;
    const apptResult = await db.collection("appointments").insertOne({
      clinicId,
      clientWaId:   waId,
      clientName,
      date,
      time,
      procedure,
      professional: professional ?? null,
      notes:        notes        ?? null,
      status:       "confirmado",
      source:       "whatsapp_ia",
      createdAt:    now,
      updatedAt:    now,
    });
    appointmentId = apptResult.insertedId;
    console.log(`[handleMessage] 📅 Agendamento criado: ${procedure} em ${date} às ${time} — id: ${appointmentId}`);
  }

  await db.collection("clients").updateOne(
    { waId, clinicId },
    {
      $set: {
        name:            clientName,
        phone:           waId,
        clinicId,
        status:          parsed.clientStatus,
        activitySummary: parsed.activitySummary,
        lastMessageAt:   now,
        updatedAt:       now,
        ...(appointmentId && { scheduledAppointmentId: appointmentId }),
      },
      $push: { messages: { $each: [clientMsg, iaMsg] } },
      $setOnInsert: {
        tags:                   [],
        intent:                 "Curioso",
        potential:              "Médio",
        aiInsight:              "",
        conversationStatus:     "active",
        pendingDoubtId:         null,
        scheduledAppointmentId: null,
        createdAt:              now,
      },
    },
    { upsert: true }
  );

  console.log(`[handleMessage] ✓ ${clientName} (${waId}) — status: ${parsed.clientStatus}`);

  return {
    reply:           parsed.reply,
    clientStatus:    parsed.clientStatus,
    activitySummary: parsed.activitySummary,
    ...(parsed.appointment && { appointment: parsed.appointment }),
  };
}

/**
 * Retorna conversas ativas nos últimos N minutos para o card em tempo real.
 */
async function getActiveConversations({ clinicId, windowMinutes = 15 }) {
  const db    = await getDb();
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  const clients = await db
    .collection("clients")
    .find(
      { clinicId: new ObjectId(clinicId), lastMessageAt: { $gte: since } },
      { projection: { _id: 1, name: 1, status: 1, activitySummary: 1, lastMessageAt: 1 } }
    )
    .sort({ lastMessageAt: -1 })
    .limit(20)
    .toArray();

  return clients.map(c => ({
    id:   c._id.toString(),
    text: c.activitySummary ?? `${c.name} está em atendimento`,
    time: c.lastMessageAt,
    type: c.status === "novo" ? "novo_lead" : c.status === "agendado" ? "agendamento" : "mensagem",
  }));
}

// ── Express App ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Middleware de autenticação (para os endpoints REST)
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next(); // auth desativado se token não configurado
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── REST: endpoint principal para o webhook ───────────────────────────────────

app.post("/chat", authMiddleware, async (req, res) => {
  const { waId, clientName, message, clinicPhone } = req.body ?? {};

  if (!waId || !clientName || !message || !clinicPhone) {
    return res.status(400).json({
      error: "Campos obrigatórios: waId, clientName, message, clinicPhone",
    });
  }

  try {
    const result = await handleMessage({ waId, clientName, message, clinicPhone });
    res.json(result);
  } catch (err) {
    console.error("[/chat]", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check para Railway
app.get("/health", (_, res) => {
  res.json({ status: "ok", version: "1.0.0", db: MONGODB_DB });
});

// ── MCP Server (protocolo SSE para Claude Code) ───────────────────────────────

const mcpServer = new McpServer({ name: "lia-clinics-remote", version: "1.0.0" });

// Ferramenta de alto nível: processar mensagem completa
mcpServer.registerTool(
  "handle_message",
  {
    title: "Handle WhatsApp Message",
    description: "Processa mensagem do WhatsApp: gera resposta IA e persiste no MongoDB",
    inputSchema: {
      waId:        z.string().describe("WhatsApp ID do cliente"),
      clientName:  z.string().describe("Nome de exibição do cliente"),
      message:     z.string().describe("Texto da mensagem"),
      clinicPhone: z.string().describe("Número WhatsApp da clínica"),
    },
  },
  async (args) => {
    try {
      const result = await handleMessage(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// Ferramenta de alto nível: conversas ativas
mcpServer.registerTool(
  "get_active_conversations",
  {
    title: "Get Active Conversations",
    description: "Lista conversas ativas nos últimos N minutos",
    inputSchema: {
      clinicId:      z.string().describe("ObjectId da clínica como string"),
      windowMinutes: z.number().optional().describe("Janela de tempo em minutos (padrão: 15)"),
    },
  },
  async ({ clinicId, windowMinutes }) => {
    try {
      const result = await getActiveConversations({ clinicId, windowMinutes });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// Ferramentas MongoDB genéricas (utilitárias)
mcpServer.registerTool(
  "mongo_find",
  {
    title: "MongoDB Find",
    description: "Busca documentos em uma coleção do banco lia-dev",
    inputSchema: {
      collection: z.string(),
      filter:     z.record(z.any()).optional(),
      projection: z.record(z.any()).optional(),
      limit:      z.number().optional(),
      sort:       z.record(z.any()).optional(),
    },
  },
  async ({ collection, filter, projection, limit, sort }) => {
    try {
      const db = await getDb();
      let cursor = db.collection(collection).find(filter || {});
      if (projection) cursor = cursor.project(projection);
      if (sort)       cursor = cursor.sort(sort);
      const docs = await cursor.limit(limit ?? 20).toArray();
      return { content: [{ type: "text", text: JSON.stringify(docs, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

mcpServer.registerTool(
  "mongo_insert_one",
  {
    title: "MongoDB Insert One",
    description: "Insere um documento em uma coleção",
    inputSchema: {
      collection: z.string(),
      document:   z.record(z.any()),
    },
  },
  async ({ collection, document }) => {
    try {
      const db     = await getDb();
      const result = await db.collection(collection).insertOne({ ...document, createdAt: new Date() });
      return { content: [{ type: "text", text: `Inserted _id: ${result.insertedId}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

mcpServer.registerTool(
  "mongo_update_one",
  {
    title: "MongoDB Update One",
    description: "Atualiza um documento em uma coleção",
    inputSchema: {
      collection: z.string(),
      filter:     z.record(z.any()),
      update:     z.record(z.any()),
      upsert:     z.boolean().optional(),
    },
  },
  async ({ collection, filter, update, upsert }) => {
    try {
      const db     = await getDb();
      const result = await db.collection(collection).updateOne(filter, update, { upsert: upsert ?? false });
      return { content: [{ type: "text", text: `Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

mcpServer.registerTool(
  "mongo_aggregate",
  {
    title: "MongoDB Aggregate",
    description: "Executa um pipeline de agregação",
    inputSchema: {
      collection: z.string(),
      pipeline:   z.array(z.record(z.any())),
    },
  },
  async ({ collection, pipeline }) => {
    try {
      const db      = await getDb();
      const results = await db.collection(collection).aggregate(pipeline).toArray();
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ── SSE endpoints para MCP protocol ──────────────────────────────────────────

const sseTransports = new Map(); // sessionId → SSEServerTransport

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/message", res);
  sseTransports.set(transport.sessionId, transport);
  res.on("close", () => {
    sseTransports.delete(transport.sessionId);
    console.log(`[sse] Sessão encerrada: ${transport.sessionId}`);
  });
  console.log(`[sse] Nova sessão: ${transport.sessionId}`);
  await mcpServer.connect(transport);
});

app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: "Sessão não encontrada" });
  }
  await transport.handlePostMessage(req, res);
});

// ── Inicialização ─────────────────────────────────────────────────────────────

async function main() {
  await getDb(); // valida a conexão antes de aceitar requests

  app.listen(PORT, () => {
    console.log(`\nLia Clinics Remote MCP Server v1.0.0`);
    console.log(`  Porta   : ${PORT}`);
    console.log(`  REST    : POST /chat`);
    console.log(`  MCP SSE : GET /sse  |  POST /message`);
    console.log(`  Health  : GET /health`);
    console.log(`  Auth    : ${AUTH_TOKEN ? "habilitada" : "desabilitada"}\n`);
  });
}

main().catch(err => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
