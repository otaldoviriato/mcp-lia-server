import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { MongoClient, ObjectId } from "mongodb";
import OpenAI from "openai";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT        = parseInt(process.env.PORT || "3001", 10);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB  || "lia-dev";
const AUTH_TOKEN  = process.env.MCP_AUTH_TOKEN;

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
- "agendado": agendamento criado com sucesso pela ferramenta create_appointment
- "parado": conversa encerrada ou sem resposta

━━━ USO DE FERRAMENTAS ━━━
Use as ferramentas quando necessário, antes de responder:
- get_available_slots: quando o cliente perguntar por horários ou quiser agendar
- create_appointment: quando o cliente confirmar data, horário e procedimento
- cancel_appointment: quando o cliente quiser cancelar um agendamento existente
- get_client_appointments: quando o cliente perguntar sobre seus agendamentos

Ao chamar create_appointment, resolva datas relativas ("amanhã", "sexta") com base em hoje (${todayISO}).

━━━ FORMATO DA RESPOSTA FINAL ━━━
Após usar as ferramentas necessárias, responda SOMENTE com JSON válido. Nada fora do JSON.

{"reply":"...","clientStatus":"novo|atendimento|agendado|parado","activitySummary":"${clientName} verbo + o que aconteceu"}`;
}

// ── Ferramentas da OpenAI ─────────────────────────────────────────────────────

function buildTools() {
  return [
    {
      type: "function",
      function: {
        name: "get_available_slots",
        description: "Verifica horários disponíveis para agendamento em uma data específica",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Data no formato YYYY-MM-DD" },
          },
          required: ["date"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_appointment",
        description: "Cria um agendamento confirmado pelo cliente no banco de dados",
        parameters: {
          type: "object",
          properties: {
            date:         { type: "string", description: "Data no formato YYYY-MM-DD" },
            time:         { type: "string", description: "Horário no formato HH:MM" },
            procedure:    { type: "string", description: "Nome do procedimento confirmado" },
            professional: { type: "string", description: "Nome do profissional (opcional)" },
            notes:        { type: "string", description: "Observações adicionais (opcional)" },
          },
          required: ["date", "time", "procedure"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "cancel_appointment",
        description: "Cancela um agendamento existente do cliente",
        parameters: {
          type: "object",
          properties: {
            appointmentId: { type: "string", description: "ID do agendamento a cancelar" },
          },
          required: ["appointmentId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_client_appointments",
        description: "Busca os agendamentos futuros e recentes do cliente",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
  ];
}

// ── Execução de ferramentas ───────────────────────────────────────────────────

async function executeTool(toolName, args, { db, clinicId, waId, clientName }) {
  switch (toolName) {

    case "get_available_slots": {
      const { date } = args;
      const existing = await db.collection("appointments")
        .find({ clinicId, date, status: { $ne: "cancelado" } })
        .project({ time: 1, _id: 0 })
        .toArray();
      const takenSlots = existing.map(a => a.time);
      const allSlots = ["08:00","09:00","10:00","11:00","14:00","15:00","16:00","17:00","18:00"];
      const available = allSlots.filter(s => !takenSlots.includes(s));
      return { date, available, taken: takenSlots };
    }

    case "create_appointment": {
      const { date, time, procedure, professional, notes } = args;
      const now = new Date();
      const result = await db.collection("appointments").insertOne({
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
      // Linka o agendamento ao cliente
      await db.collection("clients").updateOne(
        { waId, clinicId },
        { $set: { scheduledAppointmentId: result.insertedId } }
      );
      console.log(`[tool] 📅 Agendamento criado: ${procedure} em ${date} às ${time} — id: ${result.insertedId}`);
      return { success: true, appointmentId: result.insertedId.toString(), date, time, procedure };
    }

    case "cancel_appointment": {
      const { appointmentId } = args;
      const result = await db.collection("appointments").updateOne(
        { _id: new ObjectId(appointmentId), clientWaId: waId },
        { $set: { status: "cancelado", updatedAt: new Date() } }
      );
      console.log(`[tool] ❌ Agendamento cancelado: ${appointmentId}`);
      return { success: result.modifiedCount > 0, appointmentId };
    }

    case "get_client_appointments": {
      const today = new Date().toISOString().slice(0, 10);
      const appointments = await db.collection("appointments")
        .find({ clientWaId: waId, clinicId, status: { $ne: "cancelado" }, date: { $gte: today } })
        .sort({ date: 1, time: 1 })
        .limit(5)
        .toArray();
      return appointments.map(a => ({
        id:           a._id.toString(),
        date:         a.date,
        time:         a.time,
        procedure:    a.procedure,
        professional: a.professional,
        status:       a.status,
      }));
    }

    default:
      return { error: `Ferramenta desconhecida: ${toolName}` };
  }
}

// ── Lógica de Negócio ─────────────────────────────────────────────────────────

async function handleMessage({ waId, clientName, message, clinicPhone }) {
  const db = await getDb();

  // 1. Identificar clínica pelo número
  const cleanPhone = clinicPhone.replace(/\D/g, "");
  const clinic = await db.collection("clinics").findOne({ "whatsapp.number": cleanPhone });
  if (!clinic) throw new Error(`Clínica não encontrada para o número: ${cleanPhone}`);

  const clinicIdStr = clinic._id.toString();
  const clinicId    = clinic._id;

  // 2. Contexto estático + histórico do cliente (em paralelo)
  const [config, clientDoc] = await Promise.all([
    db.collection("clinicConfig").findOne({ clinicId: clinicIdStr }),
    db.collection("clients").findOne(
      { waId, clinicId },
      { projection: { messages: { $slice: -10 } } }
    ),
  ]);

  const services = config?.procedures?.map(p => p.name) ?? config?.services ?? [];
  const history  = clientDoc?.messages ?? [];

  const todayISO = new Date().toISOString().slice(0, 10);
  const todayStr = new Date().toLocaleDateString("pt-BR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const systemPrompt = buildSystemPrompt({
    clinicName:        clinic.name,
    clinicDescription: config?.description ?? null,
    services,
    businessHours:     config?.schedule ?? config?.businessHours ?? null,
    clientName,
    todayStr,
    todayISO,
  });

  // 3. Montar histórico de conversa
  const loopMessages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({
      role:    m.from === "client" ? "user" : "assistant",
      content: m.text,
    })),
    { role: "user", content: message },
  ];

  // 4. Loop de tool calling — até 5 iterações
  const tools = buildTools();
  let finalContent = null;

  for (let i = 0; i < 5; i++) {
    const aiResp = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      max_tokens:  600,
      messages:    loopMessages,
      tools,
      tool_choice: "auto",
    });

    const { finish_reason, message: aiMessage } = aiResp.choices[0];

    if (finish_reason === "tool_calls") {
      // Adiciona a mensagem da IA (com as tool_calls) ao histórico do loop
      loopMessages.push(aiMessage);

      for (const toolCall of aiMessage.tool_calls) {
        const args   = JSON.parse(toolCall.function.arguments);
        console.log(`[tool] → ${toolCall.function.name}`, args);

        const result = await executeTool(toolCall.function.name, args, { db, clinicId, waId, clientName });
        console.log(`[tool] ← ${toolCall.function.name}`, result);

        loopMessages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:      JSON.stringify(result),
        });
      }
    } else {
      // finish_reason === "stop" — resposta final
      finalContent = aiMessage.content;
      break;
    }
  }

  if (!finalContent) throw new Error("Loop de ferramentas não convergiu após 5 iterações");

  // 5. Parsear JSON da resposta final
  let parsed;
  try {
    parsed = JSON.parse(finalContent);
  } catch {
    // Fallback: se a IA não retornou JSON perfeito, usa o texto como reply
    parsed = {
      reply:           finalContent,
      clientStatus:    "atendimento",
      activitySummary: `${clientName} entrou em contato`,
    };
  }

  if (!parsed.reply) throw new Error(`Resposta sem campo reply: ${finalContent}`);

  // 6. Salvar mensagens e atualizar cliente
  const now       = new Date();
  const clientMsg = { from: "client", text: message,      createdAt: now.toISOString() };
  const iaMsg     = { from: "ia",     text: parsed.reply, createdAt: new Date(now.getTime() + 1).toISOString() };

  await db.collection("clients").updateOne(
    { waId, clinicId },
    {
      $set: {
        name:            clientName,
        phone:           waId,
        clinicId,
        status:          parsed.clientStatus  ?? "atendimento",
        activitySummary: parsed.activitySummary ?? `${clientName} entrou em contato`,
        lastMessageAt:   now,
        updatedAt:       now,
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
    clientStatus:    parsed.clientStatus  ?? "atendimento",
    activitySummary: parsed.activitySummary ?? `${clientName} entrou em contato`,
  };
}

// ── getActiveConversations ────────────────────────────────────────────────────

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

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.post("/chat", authMiddleware, async (req, res) => {
  const { waId, clientName, message, clinicPhone } = req.body ?? {};
  if (!waId || !clientName || !message || !clinicPhone) {
    return res.status(400).json({ error: "Campos obrigatórios: waId, clientName, message, clinicPhone" });
  }
  try {
    const result = await handleMessage({ waId, clientName, message, clinicPhone });
    res.json(result);
  } catch (err) {
    console.error("[/chat]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok", version: "2.0.0", db: MONGODB_DB }));

// ── MCP Server (SSE para Claude Code) ────────────────────────────────────────

const mcpServer = new McpServer({ name: "lia-clinics-remote", version: "2.0.0" });

mcpServer.registerTool("handle_message", {
  title: "Handle WhatsApp Message",
  description: "Processa mensagem do WhatsApp com tool calling + persistência no MongoDB",
  inputSchema: {
    waId:        z.string(),
    clientName:  z.string(),
    message:     z.string(),
    clinicPhone: z.string(),
  },
}, async (args) => {
  try {
    const result = await handleMessage(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
  }
});

mcpServer.registerTool("get_active_conversations", {
  title: "Get Active Conversations",
  description: "Lista conversas ativas nos últimos N minutos",
  inputSchema: {
    clinicId:      z.string(),
    windowMinutes: z.number().optional(),
  },
}, async ({ clinicId, windowMinutes }) => {
  try {
    const result = await getActiveConversations({ clinicId, windowMinutes });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
  }
});

mcpServer.registerTool("mongo_find", {
  title: "MongoDB Find",
  description: "Busca documentos em uma coleção",
  inputSchema: {
    collection: z.string(),
    filter:     z.record(z.any()).optional(),
    projection: z.record(z.any()).optional(),
    limit:      z.number().optional(),
    sort:       z.record(z.any()).optional(),
  },
}, async ({ collection, filter, projection, limit, sort }) => {
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
});

mcpServer.registerTool("mongo_insert_one", {
  title: "MongoDB Insert One",
  description: "Insere um documento em uma coleção",
  inputSchema: { collection: z.string(), document: z.record(z.any()) },
}, async ({ collection, document }) => {
  try {
    const db     = await getDb();
    const result = await db.collection(collection).insertOne({ ...document, createdAt: new Date() });
    return { content: [{ type: "text", text: `Inserted _id: ${result.insertedId}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
  }
});

mcpServer.registerTool("mongo_update_one", {
  title: "MongoDB Update One",
  description: "Atualiza um documento em uma coleção",
  inputSchema: {
    collection: z.string(),
    filter:     z.record(z.any()),
    update:     z.record(z.any()),
    upsert:     z.boolean().optional(),
  },
}, async ({ collection, filter, update, upsert }) => {
  try {
    const db     = await getDb();
    const result = await db.collection(collection).updateOne(filter, update, { upsert: upsert ?? false });
    return { content: [{ type: "text", text: `Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
  }
});

mcpServer.registerTool("mongo_aggregate", {
  title: "MongoDB Aggregate",
  description: "Executa um pipeline de agregação",
  inputSchema: { collection: z.string(), pipeline: z.array(z.record(z.any())) },
}, async ({ collection, pipeline }) => {
  try {
    const db      = await getDb();
    const results = await db.collection(collection).aggregate(pipeline).toArray();
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
  }
});

// ── SSE endpoints ─────────────────────────────────────────────────────────────

const sseTransports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/message", res);
  sseTransports.set(transport.sessionId, transport);
  res.on("close", () => sseTransports.delete(transport.sessionId));
  await mcpServer.connect(transport);
});

app.post("/message", async (req, res) => {
  const transport = sseTransports.get(req.query.sessionId);
  if (!transport) return res.status(404).json({ error: "Sessão não encontrada" });
  await transport.handlePostMessage(req, res);
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  await getDb();
  app.listen(PORT, () => {
    console.log(`\nLia Clinics MCP Server v2.0.0`);
    console.log(`  REST : POST /chat`);
    console.log(`  MCP  : GET /sse | POST /message`);
    console.log(`  Auth : ${AUTH_TOKEN ? "habilitada" : "desabilitada"}\n`);
  });
}

main().catch(err => { console.error("Erro fatal:", err); process.exit(1); });
