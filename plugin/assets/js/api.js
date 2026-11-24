/**
 * REST client for the plugin's site-guardian/v1 routes (same origin, cookie auth + WP nonce).
 */

/** WordPress-level auth failure: the nonce or login cookie is no longer valid. */
export class SessionExpiredError extends Error {
  constructor(message = "Your session expired — please refresh the page.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** Any other failure. `message` is user-friendly (Core's message, or a generic one). */
export class ApiFailure extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {string} [requestId]
   */
  constructor(code, message, status = 0, requestId = undefined) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

const GENERIC_MESSAGE = "Something went wrong. Please try again.";
const NETWORK_MESSAGE = "Could not reach the server. Please check your connection and try again.";

/**
 * @typedef {{ reply: string, conversation_id: string }} ChatResponse
 * @typedef {{ restUrl: string, nonce: string, fetch?: typeof fetch }} ApiConfig
 */

/**
 * @param {ApiConfig} config
 */
export function createApi(config) {
  const base = config.restUrl.endsWith("/") ? config.restUrl : config.restUrl + "/";
  const fetchImpl = config.fetch ?? ((...args) => globalThis.fetch(...args));

  /**
   * @param {"GET"|"POST"} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    /** @type {RequestInit} */
    const init = {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-WP-Nonce": config.nonce,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res;
    try {
      res = await fetchImpl(base + path, init);
    } catch {
      throw new ApiFailure("network_error", NETWORK_MESSAGE);
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok) {
      if (data === null || typeof data !== "object") {
        throw new ApiFailure("bad_response", GENERIC_MESSAGE, res.status);
      }
      return data;
    }

    // Core-style error passed through by the plugin: { error: { code, message }, request_id? }.
    if (data && typeof data === "object" && data.error && typeof data.error === "object") {
      const code = typeof data.error.code === "string" ? data.error.code : "error";
      const message =
        typeof data.error.message === "string" && data.error.message ? data.error.message : GENERIC_MESSAGE;
      const requestId = typeof data.request_id === "string" ? data.request_id : undefined;
      throw new ApiFailure(code, message, res.status, requestId);
    }

    // WordPress REST error: { code, message, data: { status } }. 401/403 = auth/nonce failure.
    if ((res.status === 401 || res.status === 403) && data && typeof data.code === "string") {
      throw new SessionExpiredError();
    }

    const code = data && typeof data.code === "string" ? data.code : "bad_response";
    throw new ApiFailure(code, GENERIC_MESSAGE, res.status);
  }

  return {
    /**
     * @param {string} message
     * @param {string|null|undefined} conversationId
     * @returns {Promise<ChatResponse>}
     */
    async postChat(message, conversationId) {
      /** @type {{message: string, conversation_id?: string}} */
      const body = { message };
      if (conversationId) body.conversation_id = conversationId;
      const data = await request("POST", "chat", body);
      if (typeof data.reply !== "string" || typeof data.conversation_id !== "string") {
        throw new ApiFailure("bad_response", GENERIC_MESSAGE, 200);
      }
      return { reply: data.reply, conversation_id: data.conversation_id };
    },

    /** @returns {Promise<string|null>} */
    async getConversation() {
      const data = await request("GET", "conversation");
      return typeof data.conversation_id === "string" && data.conversation_id ? data.conversation_id : null;
    },
  };
}
