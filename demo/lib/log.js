// Only structured diagnostics and known local messages may reach server logs.
// Upstream messages, stacks, URLs, headers and request/response bodies can contain credentials.
const localMessages = new Set([
  "Demo environment is not configured.", "Demo request timed out. Please retry.",
  "Demo rate limit reached. Please try again shortly.", "Prediction service is unavailable.",
  "Prediction service returned invalid JSON.", "Batch prediction service returned invalid indexes.",
  "Invalid memory response", "Missing gRPC Blob JSON fields", "Missing gRPC object JSON",
  "Missing gRPC metadata JSON fields", "Missing gRPC Blob object", "Missing gRPC account owner",
  "Missing Walrus inner state", "Missing Walrus epoch in gRPC JSON", "Unexpected gRPC content type",
  "Invalid or compressed gRPC unary frame", "Missing gRPC status trailers",
  "gRPC stream aborted", "gRPC response exceeds 16 MiB",
]);
const codes = new Set([
  "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND", "ALREADY_EXISTS",
  "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE",
  "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ERR_HTTP2_STREAM_CANCEL",
]);

export function logError(handler, stage, error, { status, elapsedMs } = {}) {
  const message = String(error?.message || "");
  console.error("[demo]", {
    handler, stage, status, elapsedMs,
    error: ["Error", "TypeError", "RangeError", "RpcError", "AbortError", "TimeoutError"].includes(error?.name) ? error.name : "ServiceError",
    ...(codes.has(error?.code) ? { code: error.code } : {}),
    ...(Number.isInteger(error?.httpStatus ?? error?.status) && (error.httpStatus ?? error.status) >= 100 && (error.httpStatus ?? error.status) <= 599 ? { httpStatus: error.httpStatus ?? error.status } : {}),
    ...(typeof error?.operation === "string" && /^(?:StateService|LedgerService)\/[A-Za-z]+$/.test(error.operation) ? { operation: error.operation } : {}),
    ...(localMessages.has(message) ? { message } : {}),
  });
}
