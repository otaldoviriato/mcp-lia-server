import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { MongoClient, ObjectId } from "mongodb";
import OpenAI from "openai";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001", 10);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "lia-dev";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!MONGODB_URI) throw new Error("MONGODB_URI env var é obrigatória");
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

/**
 * Tenta extrair um objeto JSON de uma string que pode conter texto extra.
 * Útil para evitar vazamento de JSON no WhatsApp quando a IA "tagarela".
 */
function tryExtractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ── System Prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt({ clinicName, clinicDescription, services, businessHours, clientName, todayStr, todayISO }) {
  const base = clinicDescription || "Você é uma atendente de clínica estética.";
  const servicesStr = services?.length ? `Serviços oferecidos: ${services.join(", ")}` : "";
  const hoursStr = businessHours ? `Horários de funcionamento: ${JSON.stringify(businessHours)}` : "";

  return `${base}

Você é a atendente virtual da clínica ${clinicName}.
O cliente se chama ${clientName}.
Hoje é ${todayStr} (ISO: ${todayISO}).
${servicesStr}
${hoursStr}

━━━ REGRAS DE ATENDIMENTO ━━━
- Seja natural, educada e objetiva
- Use no máximo 2 frases na resposta para o cliente
- Responda SOMENTE com informações deste prompt ou retornadas por uma ferramenta
- NUNCA use conhecimento geral seu para responder sobre a clínica — você não sabe nada sobre ela além do que está escrito aqui

━━━ O QUE VOCÊ PODE RESPONDER SEM USAR FERRAMENTAS ━━━
Apenas estas situações não exigem ferramenta:
- Saudações e apresentação ("Olá", "Como posso ajudar?")
- Confirmar o nome da clínica e a lista de serviços acima
- Horários de funcionamento acima
- Encerrar conversa educadamente

━━━ TUDO O MAIS EXIGE search_faq PRIMEIRO ━━━
Para QUALQUER outra pergunta — preços, produtos usados, duração, preparo, pós-procedimento, contraindicações, profissionais, promoções, parcelamento, diferença entre procedimentos — você OBRIGATORIAMENTE deve:

1. Chamar search_faq com a pergunta do cliente (mas reescrita com o contexto completo, ex: "O botox dói?" em vez de "isso dói?")
2. search_faq retorna uma lista de candidatos: { results: [{ question, answer, source }] }
3. VOCÊ deve analisar os candidatos e decidir:
   - Algum deles responde DIRETAMENTE o que o cliente perguntou (mesmo procedimento, mesma informação)? → Responda com suas próprias palavras. NÃO copie literalmente.
   - Os resultados falam de outro procedimento, outra informação ou são vagos? → OBRIGATÓRIO chamar register_doubt ANTES de responder. Só depois diga algo como "Vou checar isso aqui e já te falo!" (primeira pessoa)

REGRA CRÍTICA: Se a pergunta é "Quanto tempo dura o botox?" e os resultados falam de LIMPEZA DE PELE ou de PRODUTO DO BOTOX mas NÃO de DURAÇÃO DO BOTOX → esses resultados NÃO respondem → chame register_doubt.
Resultado sobre "mesmo procedimento mas informação diferente" = NÃO responde. Resultado sobre "informação certa mas procedimento diferente" = NÃO responde. Resultado genérico/vago (ex: "esse procedimento dói?") = NÃO se aplica a um procedimento específico, logo NÃO responde. Só chame register_doubt quando a resposta não estiver nos resultados.

PROIBIDO usar qualquer uma destas frases:
- "nossa equipe vai te responder", "a equipe vai responder", "já registrei sua dúvida", "equipe irá responder"
Fale sempre em primeira pessoa, como se VOCÊ fosse verificar.

PROIBIDO inventar ou deduzir qualquer detalhe específico da clínica. Esfoliantes, tônicos, marcas, preços, TEMPOS DE DURAÇÃO — você simplesmente não sabe e NUNCA deve adivinhar.
REGRA DE AMNÉSIA: Se você sabe a resposta por conhecimento geral da internet (ex: "botox dura 6 meses", "Lifting demora 2 horas"), VOCÊ ESTÁ PROIBIDA DE USAR ESSA INFORMAÇÃO. Aja como se não soubesse. Só use informações que vieram DIRETAMENTE do search_faq.

━━━ CLASSIFICAÇÃO DO CLIENTE ━━━
- "novo": primeiro contato, sem intenção definida
- "atendimento": perguntando sobre serviços, preços ou procedimentos
- "agendado": agendamento criado com sucesso pela ferramenta create_appointment
- "parado": conversa encerrada ou sem resposta

━━━ USO DE FERRAMENTAS DE AGENDA ━━━
- get_available_slots: quando o cliente perguntar por horários ou quiser agendar/remarcar
- create_appointment: quando o cliente confirmar data, horário e procedimento
- cancel_appointment: quando o cliente quiser cancelar um agendamento existente
- reschedule_appointment: quando o cliente quiser mudar a data ou horário de um agendamento existente
- get_client_appointments: quando o cliente perguntar sobre seus agendamentos ou antes de cancelar/remarcar

Ao resolver datas relativas ("amanhã", "sexta", "semana que vem"), use como base hoje (${todayISO}).
Para remarcar: primeiro chame get_client_appointments para obter o appointmentId, depois get_available_slots para confirmar disponibilidade, então reschedule_appointment.

━━━ INTENÇÃO E POTENCIAL ━━━
- intent: "Curioso", "Quer preço", "Pronto para comprar"
- potential: "Baixo", "Médio", "Alto"
Dica: Se o cliente agendar, a intenção é obrigatoriamente "Pronto para comprar" e o potencial é "Alto".

━━━ FORMATO DA RESPOSTA FINAL ━━━
Após usar as ferramentas necessárias, responda SOMENTE com JSON válido. Nada fora do JSON.

{"reasoning":"Explique em 1 frase de ONDE você tirou a informação da resposta (ex: 'Veio do search_faq', 'Conhecimento geral - ALERTA: não posso usar, vou chamar register_doubt')","reply":"...","clientStatus":"novo|atendimento|agendado|parado","activitySummary":"${clientName} verbo + o que aconteceu","intent":"Curioso|Quer preço|Pronto para comprar","potential":"Baixo|Médio|Alto"}`;
}

// ── System Prompt de Marketing ────────────────────────────────────────────────

// Corpo padrão — usado quando não há customização no banco
const DEFAULT_MARKETING_PROMPT_BODY =
`Você é a Lia, assistente virtual da empresa Lia — uma plataforma SaaS de secretária virtual com IA para clínicas odontológicas e estéticas.
Seu objetivo é qualificar e converter dentistas e donos de clínicas em clientes pagantes da Lia.
Você está conversando com {{clientName}}.
Hoje é {{todayStr}}.

━━━ SEU FOCO ━━━
- Demonstrar o ROI da Lia: clínicas que automatizam o atendimento WhatsApp recuperam 3-5 horas/dia de trabalho administrativo
- Redução de no-shows: a Lia confirma consultas automaticamente via WhatsApp
- Atendimento 24/7: nenhum paciente fica sem resposta, mesmo fora do horário comercial
- Agenda inteligente: a IA agenda, cancela e remarca sem intervenção humana
- Mais pacientes na cadeira, menos tempo da recepcionista no telefone

━━━ REGRAS ━━━
- Seja consultiva, nunca invasiva
- Máximo 2-3 frases por mensagem — seja direta e objetiva
- Fale sempre em primeira pessoa como a Lia`;

// Sufixo obrigatório — nunca editável, garante uso correto das ferramentas e formato JSON
function buildMandatorySuffix(clientName) {
  return `

━━━ AGENDA DE DEMONSTRAÇÃO ━━━
Quando o lead demonstrar interesse real em ver o produto ou pedir uma demonstração:
1. Chame check_setup_slots para ver os horários disponíveis
2. Apresente as opções de forma amigável ao lead
3. Quando ele confirmar data e hora, chame book_setup_meeting com o slotId correspondente
4. Confirme o agendamento e informe que nossa equipe vai entrar em contato para confirmar

━━━ CLASSIFICAÇÃO DO LEAD ━━━
- "novo": primeiro contato, sem intenção definida
- "qualificado": dentista ou gestor de clínica identificado, engajado
- "interessado": pediu demonstração, preço ou mais detalhes
- "convertido": demonstração agendada com sucesso via book_setup_meeting

━━━ FORMATO DA RESPOSTA FINAL ━━━
Responda SOMENTE com JSON válido. Nada fora do JSON.

{"reply":"...","leadStatus":"novo|qualificado|interessado|convertido","activitySummary":"${clientName} verbo + o que aconteceu","intent":"Curioso|Quer demonstração|Pronto para contratar","potential":"Baixo|Médio|Alto"}`;
}

function buildMarketingPrompt({ clientName, todayStr, customBody }) {
  const body = (customBody ?? DEFAULT_MARKETING_PROMPT_BODY)
    .replace(/\{\{clientName\}\}/g, clientName)
    .replace(/\{\{todayStr\}\}/g, todayStr);
  return body + buildMandatorySuffix(clientName);
}

function buildMarketingTools() {
  return [
    {
      type: "function",
      function: {
        name: "check_setup_slots",
        description: "Verifica os horários disponíveis na agenda de demonstração da Lia. Use quando o lead demonstrar interesse em ver o produto ou pedir uma reunião.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "book_setup_meeting",
        description: "Reserva um horário na agenda de demonstração. Use SOMENTE após o lead confirmar explicitamente a data e o horário.",
        parameters: {
          type: "object",
          properties: {
            slotId: { type: "string", description: "ID do slot a reservar (obtido de check_setup_slots)" },
          },
          required: ["slotId"],
        },
      },
    },
  ];
}

async function executeMarketingTool(toolName, args, { db, waId, clientName }) {
  switch (toolName) {
    case "check_setup_slots": {
      const slots = await db.collection("setup_agenda")
        .find({ available: true })
        .sort({ date: 1, time: 1 })
        .limit(10)
        .toArray();
      if (slots.length === 0) return { available: [], message: "Nenhum horário disponível no momento" };
      return {
        available: slots.map(s => ({
          id: s._id.toString(),
          date: s.date,
          time: s.time,
        })),
      };
    }

    case "book_setup_meeting": {
      const { slotId } = args;
      let slotOid;
      try { slotOid = new ObjectId(slotId); } catch { return { success: false, reason: "ID de slot inválido" }; }

      const slot = await db.collection("setup_agenda").findOne({ _id: slotOid, available: true });
      if (!slot) return { success: false, reason: "Horário não disponível ou já reservado" };

      await db.collection("setup_agenda").updateOne(
        { _id: slotOid },
        { $set: { available: false, bookedBy: { waId, name: clientName }, bookedAt: new Date() } }
      );

      await db.collection("leads_marketing").updateOne(
        { waId },
        { $set: { leadStatus: "convertido", meetingDate: slot.date, meetingTime: slot.time, updatedAt: new Date() } }
      );

      console.log(`[marketing] 🎉 Reunião marcada: ${clientName} → ${slot.date} às ${slot.time}`);
      return { success: true, date: slot.date, time: slot.time };
    }

    default:
      return { error: `Ferramenta desconhecida: ${toolName}` };
  }
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
            date: { type: "string", description: "Data no formato YYYY-MM-DD" },
            time: { type: "string", description: "Horário no formato HH:MM" },
            procedure: { type: "string", description: "Nome do procedimento confirmado" },
            professional: { type: "string", description: "Nome do profissional (opcional)" },
            notes: { type: "string", description: "Observações adicionais (opcional)" },
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
        name: "reschedule_appointment",
        description: "Remarca um agendamento existente para nova data e/ou horário",
        parameters: {
          type: "object",
          properties: {
            appointmentId: { type: "string", description: "ID do agendamento a remarcar" },
            newDate:       { type: "string", description: "Nova data no formato YYYY-MM-DD" },
            newTime:       { type: "string", description: "Novo horário no formato HH:MM" },
          },
          required: ["appointmentId", "newDate", "newTime"],
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
    {
      type: "function",
      function: {
        name: "search_faq",
        description: "Busca candidatos relevantes no FAQ da clínica e no histórico de dúvidas respondidas. Retorna uma lista de resultados ({ results: [...] }) para você analisar e decidir se algum responde a pergunta do cliente. Chame SEMPRE antes de registrar uma nova dúvida.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "A pergunta do cliente reescrita de forma autossuficiente e completa, incluindo o nome do procedimento ou serviço em questão. Não use pronomes como 'esse' ou 'isso'." },
          },
          required: ["question"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "register_doubt",
        description: "Registra uma dúvida sem resposta para que a equipe da clínica responda. Use APENAS se search_faq retornar found: false.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "A dúvida do cliente reescrita de forma clara e COMPLETA, incluindo o nome do procedimento/contexto para que possa ser entendida isoladamente (ex: 'O Lifting Temporal dói?' em vez de 'esse procedimento dói?')" },
          },
          required: ["question"],
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
      const allSlots = ["08:00", "09:00", "10:00", "11:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
      const available = allSlots.filter(s => !takenSlots.includes(s));
      return { date, available, taken: takenSlots };
    }

    case "create_appointment": {
      const { date, time, procedure, professional, notes } = args;
      const now = new Date();
      const result = await db.collection("appointments").insertOne({
        clinicId,
        clientWaId: waId,
        clientName,
        date,
        time,
        procedure,
        professional: professional ?? null,
        notes: notes ?? null,
        status: "confirmado",
        source: "whatsapp_ia",
        createdAt: now,
        updatedAt: now,
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

    case "reschedule_appointment": {
      const { appointmentId, newDate, newTime } = args;
      // Verifica se o novo horário está disponível
      const conflict = await db.collection("appointments").findOne({
        clinicId,
        date: newDate,
        time: newTime,
        status: { $ne: "cancelado" },
        _id: { $ne: new ObjectId(appointmentId) },
      });
      if (conflict) {
        return { success: false, reason: `Horário ${newTime} do dia ${newDate} já está ocupado` };
      }
      const result = await db.collection("appointments").updateOne(
        { _id: new ObjectId(appointmentId), clientWaId: waId },
        { $set: { date: newDate, time: newTime, status: "confirmado", updatedAt: new Date() } }
      );
      console.log(`[tool] 🔄 Agendamento remarcado: ${appointmentId} → ${newDate} às ${newTime}`);
      return { success: result.modifiedCount > 0, appointmentId, newDate, newTime };
    }

    case "get_client_appointments": {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
      const appointments = await db.collection("appointments")
        .find({ clientWaId: waId, clinicId, status: { $ne: "cancelado" }, date: { $gte: today } })
        .sort({ date: 1, time: 1 })
        .limit(5)
        .toArray();
      return appointments.map(a => ({
        id: a._id.toString(),
        date: a.date,
        time: a.time,
        procedure: a.procedure,
        professional: a.professional,
        status: a.status,
      }));
    }

    case "search_faq": {
      const { question } = args;
      const clinicIdStr = clinicId.toString();
      const queryWords = question.toLowerCase().split(/[\s,.!?]+/).filter(w => w.length > 2);

      // Calcula quantas palavras da query aparecem no texto candidato
      const scoreText = (text) => {
        if (!text) return 0;
        const lower = text.toLowerCase();
        return queryWords.filter(w => lower.includes(w)).length;
      };

      // 1. FAQ da clínica
      const config = await db.collection("clinicConfig").findOne({ clinicId: clinicIdStr });
      const faqCandidates = (config?.faq ?? [])
        .map(item => ({
          question: item.question,
          answer: item.answer,
          source: "faq",
          score: scoreText(item.question) + scoreText(item.answer),
        }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      // 2. Dúvidas já respondidas (aceita clinicId como ObjectId ou string)
      const answeredDoubts = await db.collection("doubts")
        .find({ $or: [{ clinicId }, { clinicId: clinicIdStr }], status: "respondida" })
        .limit(100)
        .toArray();

      const doubtCandidates = answeredDoubts
        .map(d => ({
          question: d.question,
          answer: d.answer,
          source: "historico",
          score: scoreText(d.question),
        }))
        .filter(d => d.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      const results = [...faqCandidates, ...doubtCandidates]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(({ question, answer, source }) => ({ question, answer, source }));

      return { results };
    }

    case "register_doubt": {
      const { question } = args;
      const now = new Date();

      const result = await db.collection("doubts").insertOne({
        clinicId,
        clientName,
        phone: waId,
        question,
        status: "pendente",
        createdAt: now,
      });

      await db.collection("clients").updateOne(
        { waId, clinicId },
        { $set: { pendingDoubtId: result.insertedId.toString(), updatedAt: now } }
      );

      console.log(`[tool] ❓ Dúvida registrada: "${question}" — id: ${result.insertedId}`);
      return { success: true, doubtId: result.insertedId.toString() };
    }

    default:
      return { error: `Ferramenta desconhecida: ${toolName}` };
  }
}

// ── Lógica de Negócio ─────────────────────────────────────────────────────────

async function handleMarketingMessage({ waId, clientName, message, db }) {
  const leadDoc = await db.collection("leads_marketing").findOne(
    { waId },
    { projection: { messages: { $slice: -10 } } }
  );
  const history = leadDoc?.messages ?? [];

  const today = new Date();
  const todayStr = today.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // Carrega prompt customizado do banco (ou usa o padrão se não houver)
  const promptConfig = await db.collection("marketing_config").findOne({ type: "system_prompt" });
  const systemPrompt = buildMarketingPrompt({ clientName, todayStr, customBody: promptConfig?.content ?? null });
  const tools = buildMarketingTools();

  const loopMessages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({
      role: m.from === "client" ? "user" : "assistant",
      content: m.text,
    })),
    { role: "user", content: message },
  ];

  let finalContent = null;

  for (let i = 0; i < 5; i++) {
    const aiResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 400,
      messages: loopMessages,
      tools,
      tool_choice: "auto",
      response_format: { type: "json_object" },
    });

    const { finish_reason, message: aiMessage } = aiResp.choices[0];

    if (finish_reason === "tool_calls") {
      loopMessages.push(aiMessage);

      for (const toolCall of aiMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        console.log(`[marketing:tool] → ${toolCall.function.name}`, args);

        const result = await executeMarketingTool(toolCall.function.name, args, { db, waId, clientName });
        console.log(`[marketing:tool] ← ${toolCall.function.name}`, result);

        loopMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    } else {
      finalContent = aiMessage.content;
      break;
    }
  }

  if (!finalContent) throw new Error("Loop de ferramentas marketing não convergiu após 5 iterações");

  let parsed = tryExtractJson(finalContent);

  if (!parsed?.reply) {
    parsed = {
      reply: finalContent || "Olá! Sou a Lia. Como posso ajudar sua clínica?",
      leadStatus: "novo",
      activitySummary: `${clientName} entrou em contato`,
    };
  }

  const now = new Date();
  const clientMsg = { from: "client", text: message, createdAt: now.toISOString() };
  const iaMsg    = { from: "ia",     text: parsed.reply, createdAt: new Date(now.getTime() + 1).toISOString() };

  await db.collection("leads_marketing").updateOne(
    { waId },
    {
      $set: {
        name:            clientName,
        phone:           waId,
        leadStatus:      parsed.leadStatus ?? "novo",
        activitySummary: parsed.activitySummary ?? `${clientName} entrou em contato`,
        intent:          parsed.intent ?? "Curioso",
        potential:       parsed.potential ?? "Médio",
        lastMessageAt:   now,
        updatedAt:       now,
      },
      $push:        { messages: { $each: [clientMsg, iaMsg] } },
      $setOnInsert: { createdAt: now, source: "whatsapp_marketing", ia_paused: false },
    },
    { upsert: true }
  );

  console.log(`[marketing] ✓ ${clientName} (${waId}) — status: ${parsed.leadStatus}`);

  return {
    reply:           parsed.reply,
    clientStatus:    "atendimento",
    activitySummary: parsed.activitySummary ?? `${clientName} entrou em contato`,
    intent:          parsed.intent ?? "Curioso",
    potential:       parsed.potential ?? "Médio",
  };
}

async function handleMessage({ waId, clientName, message, phoneNumberId, scenario = "clinic" }) {
  const db = await getDb();

  if (scenario === "marketing") {
    return handleMarketingMessage({ waId, clientName, message, db });
  }

  // 1. Identificar clínica pelo phone_number_id
  const clinic = await db.collection("clinics").findOne({ "whatsapp.phone_number_id": phoneNumberId });
  if (!clinic) throw new Error(`Clínica não encontrada para phone_number_id: ${phoneNumberId}`);

  const clinicIdStr = clinic._id.toString();
  const clinicId = clinic._id;

  // 2. Contexto estático + histórico do cliente (em paralelo)
  const [config, clientDoc] = await Promise.all([
    db.collection("clinicConfig").findOne({ clinicId: clinicIdStr }),
    db.collection("clients").findOne(
      { waId, clinicId },
      { projection: { messages: { $slice: -10 } } }
    ),
  ]);

  const services = config?.procedures?.map(p => p.name) ?? config?.services ?? [];
  const history = clientDoc?.messages ?? [];

  const today = new Date();
  const todayISO = today.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const todayStr = today.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const systemPrompt = buildSystemPrompt({
    clinicName: clinic.name,
    clinicDescription: config?.description ?? null,
    services,
    businessHours: config?.schedule ?? config?.businessHours ?? null,
    clientName,
    todayStr,
    todayISO,
  });

  // 3. Montar histórico de conversa
  const loopMessages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({
      role: m.from === "client" ? "user" : "assistant",
      content: m.text,
    })),
    { role: "user", content: message },
  ];

  // 4. Loop de tool calling — até 5 iterações
  const tools = buildTools();
  let finalContent = null;

  for (let i = 0; i < 5; i++) {
    const aiResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 600,
      messages: loopMessages,
      tools,
      tool_choice: "auto",
      response_format: { type: "json_object" },
    });

    const { finish_reason, message: aiMessage } = aiResp.choices[0];

    if (finish_reason === "tool_calls") {
      // Adiciona a mensagem da IA (com as tool_calls) ao histórico do loop
      loopMessages.push(aiMessage);

      for (const toolCall of aiMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        console.log(`[tool] → ${toolCall.function.name}`, args);

        const result = await executeTool(toolCall.function.name, args, { db, clinicId, waId, clientName });
        console.log(`[tool] ← ${toolCall.function.name}`, result);

        loopMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
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
  let parsed = tryExtractJson(finalContent);

  if (!parsed || !parsed.reply) {
    console.warn(`[handleMessage] IA não retornou JSON válido ou faltou campo reply. Conteúdo: ${finalContent}`);
    parsed = {
      reply: finalContent || "Tive um problema ao processar sua resposta.",
      clientStatus: "atendimento",
      activitySummary: `${clientName} entrou em contato`,
    };
  }

  if (!parsed.reply) throw new Error(`Resposta sem campo reply: ${finalContent}`);

  // 6. Salvar mensagens e atualizar cliente
  const now = new Date();
  const clientMsg = { from: "client", text: message, createdAt: now.toISOString() };
  const iaMsg = { from: "ia", text: parsed.reply, createdAt: new Date(now.getTime() + 1).toISOString() };

  await db.collection("clients").updateOne(
    { waId, clinicId },
    {
      $set: {
        name: clientName,
        phone: waId,
        clinicId,
        status: parsed.clientStatus ?? "atendimento",
        activitySummary: parsed.activitySummary ?? `${clientName} entrou em contato`,
        intent: parsed.intent ?? "Curioso",
        potential: parsed.potential ?? "Médio",
        lastMessageAt: now,
        updatedAt: now,
      },
      $push: { messages: { $each: [clientMsg, iaMsg] } },
      $setOnInsert: {
        tags: [],
        aiInsight: "",
        conversationStatus: "active",
        pendingDoubtId: null,
        scheduledAppointmentId: null,
        createdAt: now,
      },
    },
    { upsert: true }
  );

  console.log(`[handleMessage] ✓ ${clientName} (${waId}) — status: ${parsed.clientStatus}`);

  return {
    reply: parsed.reply,
    clientStatus: parsed.clientStatus ?? "atendimento",
    activitySummary: parsed.activitySummary ?? `${clientName} entrou em contato`,
    intent: parsed.intent ?? "Curioso",
    potential: parsed.potential ?? "Médio",
  };
}

// ── getActiveConversations ────────────────────────────────────────────────────

async function getActiveConversations({ clinicId, windowMinutes = 15 }) {
  const db = await getDb();
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
    id: c._id.toString(),
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
  const { waId, clientName, message, phoneNumberId, scenario } = req.body ?? {};
  if (!waId || !clientName || !message || !phoneNumberId) {
    return res.status(400).json({ error: "Campos obrigatórios: waId, clientName, message, phoneNumberId" });
  }
  try {
    const result = await handleMessage({ waId, clientName, message, phoneNumberId, scenario });
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
    waId:          z.string(),
    clientName:    z.string(),
    message:       z.string(),
    phoneNumberId: z.string(),
    scenario:      z.enum(["marketing", "clinic"]).optional(),
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
    clinicId: z.string(),
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
    filter: z.record(z.any()).optional(),
    projection: z.record(z.any()).optional(),
    limit: z.number().optional(),
    sort: z.record(z.any()).optional(),
  },
}, async ({ collection, filter, projection, limit, sort }) => {
  try {
    const db = await getDb();
    let cursor = db.collection(collection).find(filter || {});
    if (projection) cursor = cursor.project(projection);
    if (sort) cursor = cursor.sort(sort);
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
    const db = await getDb();
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
    filter: z.record(z.any()),
    update: z.record(z.any()),
    upsert: z.boolean().optional(),
  },
}, async ({ collection, filter, update, upsert }) => {
  try {
    const db = await getDb();
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
    const db = await getDb();
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
