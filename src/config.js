import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Thieu bien moi truong ${name} (xem .env.example)`);
  return value;
}

export function loadConfig({ needZalo = true } = {}) {
  return {
    memwal: {
      key: required("MEMWAL_PRIVATE_KEY"),
      accountId: required("MEMWAL_ACCOUNT_ID"),
      serverUrl: process.env.MEMWAL_SERVER_URL || "https://relayer.memory.walrus.xyz",
    },
    tatum: {
      apiKey: process.env.TATUM_API_KEY || "",
      rpcUrl: process.env.TATUM_SUI_RPC || "https://sui-mainnet.gateway.tatum.io",
      grpcUrl: process.env.TATUM_SUI_GRPC || "https://sui-mainnet-grpc.gateway.tatum.io:443",
      transport: process.env.TATUM_TRANSPORT || "grpc",
      wallet: process.env.WALLET_ADDRESS || "", // trong -> doc owner tu MemWalAccount tren chain
    },
    namespacePrefix: process.env.NAMESPACE_PREFIX || "l1demo",
    knowledgeDir: process.env.KNOWLEDGE_DIR || "mock-sharepoint",
    addendumFile: process.env.ADDENDUM_FILE || "",
    includePrivateKb: process.env.INCLUDE_PRIVATE_KB === "true",
    llm: {
      baseURL: required("LLM_BASE_URL"),
      apiKey: required("LLM_API_KEY"),
      model: required("LLM_MODEL"),
      fallbackModels: (process.env.LLM_FALLBACK_MODELS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    zaloToken: needZalo ? required("ZALO_BOT_TOKEN") : process.env.ZALO_BOT_TOKEN || "",
    allowedChatIds: (process.env.ALLOWED_CHAT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowedDmUserIds: (process.env.ALLOWED_DM_USER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    incident: {
      windowMinutes: Number(process.env.INCIDENT_WINDOW_MINUTES || 60),
      minReports: Number(process.env.INCIDENT_MIN_REPORTS || 3),
    },
  };
}
