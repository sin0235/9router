import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*",
  "X-Accel-Buffering": "no"
};

const HEARTBEAT_INTERVAL_MS = 15000;
const SSE_ENCODER = new TextEncoder();

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  const needsCodexTranslation = provider === "codex" && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    // Codex returns Responses API SSE → translate to client format
    let codexTarget;
    if (sourceFormat === FORMATS.OPENAI_RESPONSES) codexTarget = FORMATS.OPENAI_RESPONSES;
    else if (sourceFormat === FORMATS.CLAUDE) codexTarget = FORMATS.CLAUDE;
    else if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) codexTarget = FORMATS.ANTIGRAVITY;
    else codexTarget = FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete }) {
  if (onRequestSuccess) onRequestSuccess();

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const transformedBody = withHeartbeat(pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal), streamController);

  persistStreamingStart({ provider, model, connectionId, body, stream, translatedBody, finalBody, requestStartTime });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

export function handleDeferredStreamingResponse({ executeProvider, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete }) {
  const responseBody = new ReadableStream({
    async start(controller) {
      let heartbeat = null;
      const send = (text) => controller.enqueue(SSE_ENCODER.encode(text));
      send(": connected\n\n");
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_INTERVAL_MS);

      try {
        const result = await executeProvider();
        const providerResponse = result.response;
        if (!providerResponse?.ok) {
          const status = providerResponse?.status || 502;
          const text = providerResponse ? await providerResponse.text() : "Provider did not return a response.";
          send(`event: error\ndata: ${JSON.stringify({ status, error: text })}\n\n`);
          return;
        }

        if (onRequestSuccess) await onRequestSuccess();
        const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey });
        const transformed = providerResponse.body.pipeThrough(transformStream);
        const reader = transformed.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (error) {
        send(`event: error\ndata: ${JSON.stringify({ error: error?.message || String(error) })}\n\n`);
        streamController.handleError(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        streamController.handleComplete();
        controller.close();
      }
    },
    cancel(reason) {
      streamController.handleDisconnect(reason || "cancelled");
    }
  });

  persistStreamingStart({ provider, model, connectionId, body, stream, translatedBody, finalBody, requestStartTime });

  return {
    success: true,
    response: new Response(responseBody, { headers: SSE_HEADERS })
  };
}

function withHeartbeat(readable, streamController) {
  const reader = readable.getReader();
  return new ReadableStream({
    async start(controller) {
      let heartbeat = null;
      const send = (text) => controller.enqueue(SSE_ENCODER.encode(text));
      send(": connected\n\n");
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_INTERVAL_MS);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (error) {
        streamController.handleError(error instanceof Error ? error : new Error(String(error)));
        controller.error(error);
        return;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      controller.close();
    },
    cancel(reason) {
      streamController.handleDisconnect(reason || "cancelled");
      return reader.cancel(reason);
    }
  });
}

function persistStreamingStart({ provider, model, connectionId, body, stream, translatedBody, finalBody, requestStartTime }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE" });
  };

  return { onStreamComplete, streamDetailId };
}
