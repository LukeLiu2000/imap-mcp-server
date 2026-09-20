#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";

// src/services/imap-service.ts
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// src/types/index.ts
var DEFAULT_BODY_MAX_LENGTH = 1e4;
var DEFAULT_BODY_FORMAT = "markdown";
function isSystemFlag(flag) {
  return flag.startsWith("\\");
}

// src/services/html-to-markdown.ts
import TurndownService from "turndown";
import gfmPlugin from "turndown-plugin-gfm";
var { strikethrough } = gfmPlugin;
var INVISIBLE_CODE_POINTS = [
  173,
  847,
  1564,
  4447,
  4448,
  6068,
  6069,
  6158,
  8203,
  8204,
  8205,
  8206,
  8207,
  8232,
  8233,
  8234,
  8235,
  8236,
  8237,
  8238,
  8288,
  8289,
  8290,
  8291,
  8292,
  8294,
  8295,
  8296,
  8297,
  8298,
  8299,
  8300,
  8301,
  8302,
  8303,
  65279
];
var INVISIBLE = new RegExp(
  "[" + INVISIBLE_CODE_POINTS.map((c) => "\\u" + c.toString(16).padStart(4, "0")).join("") + "]",
  "g"
);
var NBSP = /\u00a0/g;
function isHidden(node) {
  if (!node || typeof node.getAttribute !== "function") return false;
  const style = (node.getAttribute("style") || "").replace(/\s+/g, "").toLowerCase();
  if (!style) return false;
  return /display:none|visibility:hidden|(?:max-height|font-size|line-height|opacity):0(?![.\d])/.test(style);
}
function buildService() {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*"
  });
  td.use(strikethrough);
  td.remove(["style", "script", "head", "title", "noscript"]);
  td.addRule("flattenTableContainers", {
    filter: ["table", "thead", "tbody", "tfoot", "tr", "colgroup", "col", "caption"],
    replacement: (content) => content
  });
  td.addRule("flattenTableCell", {
    filter: ["th", "td"],
    replacement: (content) => {
      const t = content.trim();
      return t ? t + "\n\n" : "";
    }
  });
  td.addRule("stripHidden", {
    filter: (node) => isHidden(node),
    replacement: () => ""
  });
  td.addRule("imgAlt", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node.getAttribute("alt") || "").trim();
      return alt || "";
    }
  });
  td.addRule("shortLink", {
    filter: (node) => node.nodeName === "A" && !!node.getAttribute("href"),
    replacement: (content, node) => {
      const text = content.trim();
      if (!text) return "";
      let href = (node.getAttribute("href") || "").trim();
      if (!href || href.startsWith("mailto:")) return text;
      if (href.length > 100) href = href.split(/[?#]/)[0];
      if (!href || href === text) return text;
      return `[${text}](${href})`;
    }
  });
  return td;
}
var service = buildService();
function htmlToMarkdown(html) {
  if (!html || !html.trim()) return "";
  let md;
  try {
    md = service.turndown(html);
  } catch {
    md = html.replace(/<[^>]+>/g, " ");
  }
  return normalizeWhitespace(md);
}
function normalizeWhitespace(text) {
  let t = text.replace(INVISIBLE, "").replace(NBSP, " ");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
  return t.trim();
}

// src/utils/env-credentials.ts
var ENV_CREDENTIAL_SUFFIXES = {
  imapUser: "_IMAP_USERNAME",
  imapPassword: "_IMAP_PASSWORD",
  smtpUser: "_SMTP_USERNAME",
  smtpPassword: "_SMTP_PASSWORD"
};
function envAccountKey(accountName) {
  return accountName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
function envVarName(accountName, suffix) {
  return `IMAP_MCP_ACCOUNT_${envAccountKey(accountName)}${suffix}`;
}
function assertCredentialsResolved(account, channel) {
  const missing = [];
  const require2 = (value, suffix) => {
    if (value === "") missing.push(envVarName(account.name, suffix));
  };
  if (channel === "imap") {
    require2(account.user, ENV_CREDENTIAL_SUFFIXES.imapUser);
    require2(account.password, ENV_CREDENTIAL_SUFFIXES.imapPassword);
  } else {
    if (account.smtp?.user === "") {
      missing.push(envVarName(account.name, ENV_CREDENTIAL_SUFFIXES.smtpUser));
    } else if (!(account.smtp?.user || account.user)) {
      require2(account.user, ENV_CREDENTIAL_SUFFIXES.imapUser);
    }
    if (account.smtp?.password === "") {
      missing.push(envVarName(account.name, ENV_CREDENTIAL_SUFFIXES.smtpPassword));
    } else if (!(account.smtp?.password || account.password)) {
      require2(account.password, ENV_CREDENTIAL_SUFFIXES.imapPassword);
    }
  }
  if (missing.length === 0) return;
  const label = channel === "imap" ? "IMAP" : "SMTP";
  throw new Error(
    `Account "${account.name}" has ${label} credentials marked as environment-managed, but ${missing.length === 1 ? "this variable was" : "these variables were"} not set when the server started: ${missing.join(", ")}. Set ${missing.length === 1 ? "it" : "them"} and restart the server, or store the credentials on the account via imap_update_account.`
  );
}

// src/services/imap-service.ts
var PROVIDERS_REQUIRING_IMAP_ENABLE = [
  {
    pattern: /gmx\.(net|de|at|ch|com)/i,
    name: "GMX",
    settingsPath: "Settings \u2192 Email \u2192 POP3 & IMAP \u2192 Enable IMAP access"
  },
  {
    pattern: /web\.de/i,
    name: "WEB.DE",
    settingsPath: "Settings \u2192 Email \u2192 POP3 & IMAP \u2192 Enable IMAP access"
  },
  {
    pattern: /zoho\.(com|eu)/i,
    name: "Zoho Mail",
    settingsPath: "Settings \u2192 Mail Accounts \u2192 IMAP Access \u2192 Enable"
  },
  {
    pattern: /yahoo\.(com|de|co\.uk|fr|es|it)/i,
    name: "Yahoo Mail",
    settingsPath: "Account Security settings \u2192 Generate app password"
  },
  {
    pattern: /gmail\.com|googlemail\.com/i,
    name: "Gmail",
    settingsPath: "Settings \u2192 See all settings \u2192 Forwarding and POP/IMAP \u2192 Enable IMAP"
  }
];
var IMAP_DISABLED_PATTERNS = [
  /imap.*disabled/i,
  /imap.*not.*enabled/i,
  /imap.*access.*denied/i,
  /\[UNAVAILABLE\]/i,
  /\[ALERT\].*imap/i,
  /imap.*not.*activated/i,
  /please.*enable.*imap/i,
  /enable.*imap.*access/i,
  /pop3.*imap.*disabled/i
];
function enrichConnectionError(error, host) {
  const originalMessage = error instanceof Error ? error.message : "Connection failed";
  const looksLikeImapDisabled = IMAP_DISABLED_PATTERNS.some((pattern) => pattern.test(originalMessage));
  if (!looksLikeImapDisabled) {
    return originalMessage;
  }
  const matchedProvider = PROVIDERS_REQUIRING_IMAP_ENABLE.find((p) => p.pattern.test(host));
  if (matchedProvider) {
    return `${originalMessage}

Hint: ${matchedProvider.name} requires IMAP access to be manually enabled. Go to: ${matchedProvider.settingsPath}`;
  }
  return `${originalMessage}

Hint: Some providers (e.g. GMX, WEB.DE, Zoho) require IMAP access to be manually enabled in the account settings (usually under Settings \u2192 Email \u2192 POP3 & IMAP).`;
}
function parseRawHeaders(raw) {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const headers = {};
  let current = null;
  const commit = () => {
    if (!current) return;
    const key = current.key.toLowerCase().trim();
    const val = current.value.trim();
    if (key) {
      headers[key] = headers[key] !== void 0 ? `${headers[key]}
${val}` : val;
    }
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    if (/^[ \t]/.test(line)) {
      if (current) current.value += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    commit();
    current = { key: line.slice(0, idx), value: line.slice(idx + 1) };
  }
  commit();
  return headers;
}
var ImapService = class {
  connections = /* @__PURE__ */ new Map();
  reconnectAttempts = /* @__PURE__ */ new Map();
  maxReconnectAttempts = 3;
  accountManager;
  setAccountManager(accountManager2) {
    this.accountManager = accountManager2;
  }
  async connect(account) {
    const existing = this.connections.get(account.id);
    if (existing?.isConnected) {
      return;
    }
    assertCredentialsResolved(account, "imap");
    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.tls,
      // Validate the certificate against the host we actually dial. On a
      // STARTTLS upgrade imapflow passes no host to Node's TLS layer, and for
      // an IP host it also omits the SNI servername, so Node would otherwise
      // check the cert against a default of "localhost" and reject a cert
      // bound to e.g. 127.0.0.1 (local bridges like ProtonMail Bridge).
      tls: { host: account.host },
      auth: {
        user: account.user,
        pass: account.password,
        loginMethod: account.loginMethod
      },
      logger: false
    });
    client.on("error", (err) => {
      console.error(`IMAP error for account ${account.id}:`, err.message);
      const state = this.connections.get(account.id);
      if (state) {
        state.isConnected = false;
      }
    });
    client.on("close", () => {
      const state = this.connections.get(account.id);
      if (state) {
        state.isConnected = false;
      }
    });
    try {
      await client.connect();
    } catch (err) {
      throw new Error(enrichConnectionError(err, account.host));
    }
    this.connections.set(account.id, {
      client,
      account,
      isConnected: true
    });
    this.reconnectAttempts.set(account.id, 0);
  }
  async disconnect(accountId) {
    const state = this.connections.get(accountId);
    if (state) {
      try {
        await state.client.logout();
      } catch {
      }
      this.connections.delete(accountId);
      this.reconnectAttempts.delete(accountId);
    }
  }
  async ensureConnected(accountId) {
    let state = this.connections.get(accountId);
    if (!state) {
      if (this.accountManager) {
        const account = this.accountManager.getAccount(accountId);
        if (account) {
          await this.connect(account);
          state = this.connections.get(accountId);
        }
      }
      if (!state) {
        throw new Error(`No connection configured for account ${accountId}`);
      }
    }
    if (!state.isConnected || !state.client.usable) {
      const attempts = this.reconnectAttempts.get(accountId) || 0;
      if (attempts >= this.maxReconnectAttempts) {
        throw new Error(`Failed to reconnect to account ${accountId} after ${this.maxReconnectAttempts} attempts`);
      }
      this.reconnectAttempts.set(accountId, attempts + 1);
      console.log(`Reconnecting to account ${accountId} (attempt ${attempts + 1})`);
      const account = state.account;
      try {
        try {
          await state.client.logout();
        } catch {
        }
        this.connections.delete(accountId);
        await this.connect(account);
        state = this.connections.get(accountId);
        if (!state) {
          throw new Error("connection state missing after reconnect");
        }
      } catch (err) {
        throw new Error(`Failed to reconnect: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return state.client;
  }
  async listFolders(accountId) {
    const client = await this.ensureConnected(accountId);
    const folders = [];
    const list = await client.list();
    for (const folder of list) {
      folders.push({
        name: folder.path,
        delimiter: folder.delimiter,
        attributes: Array.from(folder.flags || []),
        specialUse: folder.specialUse,
        children: folder.folders ? this.convertFolderList(folder.folders) : void 0
      });
    }
    return folders;
  }
  convertFolderList(folders) {
    return folders.map((f) => ({
      name: f.path,
      delimiter: f.delimiter,
      attributes: Array.from(f.flags || []),
      specialUse: f.specialUse,
      children: f.folders ? this.convertFolderList(f.folders) : void 0
    }));
  }
  async selectFolder(accountId, folderName) {
    const client = await this.ensureConnected(accountId);
    return await client.mailboxOpen(folderName);
  }
  async getFolderStatus(accountId, folderName) {
    const client = await this.ensureConnected(accountId);
    const status = await client.status(folderName, {
      messages: true,
      recent: true,
      unseen: true,
      uidNext: true,
      uidValidity: true
    });
    return {
      messages: Number(status.messages ?? 0),
      recent: Number(status.recent ?? 0),
      unseen: Number(status.unseen ?? 0),
      uidValidity: Number(status.uidValidity ?? 0),
      uidNext: Number(status.uidNext ?? 0)
    };
  }
  /**
   * Search a folder by criteria. By default returns lightweight headers only;
   * set `options.includeBody = true` to fetch the RFC822 source in the same
   * round-trip and parse the body with mailparser (markdown by default,
   * matching `imap_get_email`).
   *
   * Backwards-compatible: when `options` is omitted or `includeBody` is
   * false, the returned shape is identical to the previous version — no
   * body fields attached.
   */
  async searchEmails(accountId, folderName, criteria, options) {
    const client = await this.ensureConnected(accountId);
    const includeBody = options?.includeBody === true;
    const bodyMaxLength = options?.bodyMaxLength ?? DEFAULT_BODY_MAX_LENGTH;
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const searchQuery = this.buildSearchQuery(criteria);
      const uids = await client.search(searchQuery, { uid: true });
      if (!uids || uids.length === 0) {
        return [];
      }
      const fetchQuery = {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        ...includeBody ? { source: true } : {}
      };
      const messages = [];
      for await (const msg of client.fetch(uids, fetchQuery, { uid: true })) {
        const flags = Array.from(msg.flags || []);
        const base = {
          uid: msg.uid,
          date: new Date(msg.internalDate || msg.envelope?.date || Date.now()),
          from: msg.envelope?.from?.[0] ? this.formatAddress(msg.envelope.from[0]) : "",
          to: msg.envelope?.to?.map((addr) => this.formatAddress(addr)) || [],
          subject: msg.envelope?.subject || "",
          messageId: msg.envelope?.messageId || "",
          inReplyTo: msg.envelope?.inReplyTo,
          flags,
          customKeywords: flags.filter((f) => !isSystemFlag(f))
        };
        if (!includeBody || !msg.source) {
          messages.push(base);
          continue;
        }
        try {
          const rendered = await this.buildEmailContentFromSource(msg.uid, msg.source, msg.flags, {
            bodyFormat: options?.bodyFormat ?? DEFAULT_BODY_FORMAT,
            bodyMaxLength,
            includeAttachmentText: false
          });
          messages.push(this.mergeBodyIntoMessage(base, rendered, options?.bodyFormat ?? DEFAULT_BODY_FORMAT));
        } catch {
          messages.push(base);
        }
      }
      return messages;
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  /**
   * Fetch the raw headers for a set of UIDs in a single round-trip and return a
   * map of uid → parsed header record (lowercased header names). Does **not**
   * fetch or parse message bodies — used for lightweight header analysis such
   * as spam indicator checks. UIDs with no headers returned are omitted.
   */
  async fetchHeadersForUids(accountId, folderName, uids) {
    const result = /* @__PURE__ */ new Map();
    if (!uids || uids.length === 0) {
      return result;
    }
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      for await (const msg of client.fetch(uids, { uid: true, headers: true }, { uid: true })) {
        if (!msg.headers) continue;
        result.set(msg.uid, parseRawHeaders(msg.headers));
      }
      return result;
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  /**
   * Get the newest `count` messages in `folderName`. By default returns
   * lightweight headers only; set `options.includeBody = true` to also fetch
   * and parse the body of each message.
   *
   * Backwards-compatible: when `options` is omitted, the returned shape is
   * identical to the previous version.
   */
  /**
   * Address the newest `count` messages of the currently open mailbox.
   *
   * Preferred form is a sequence-number range derived from EXISTS, which the
   * server already reported when the mailbox was selected. Some servers answer
   * SEARCH with an empty set even though EXISTS is non-zero (#138), which used
   * to make every read path here come back empty.
   *
   * Returns `null` when the mailbox is genuinely empty, or the SEARCH-derived
   * UID list when the mailbox metadata is unavailable for some reason.
   */
  async latestMessageRange(client, count) {
    const exists = Number(client.mailbox?.exists);
    if (Number.isFinite(exists)) {
      if (exists <= 0) {
        return null;
      }
      const first = Math.max(1, exists - count + 1);
      return { value: `${first}:${exists}`, options: {} };
    }
    const uids = await client.search({ all: true }, { uid: true });
    if (!uids || uids.length === 0) {
      return null;
    }
    return { value: [...uids].sort((a, b) => a - b).slice(-count), options: { uid: true } };
  }
  async getLatestEmails(accountId, folderName, count, options) {
    const client = await this.ensureConnected(accountId);
    const includeBody = options?.includeBody === true;
    const bodyMaxLength = options?.bodyMaxLength ?? DEFAULT_BODY_MAX_LENGTH;
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const fetchQuery = {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        ...includeBody ? { source: true } : {}
      };
      const range = await this.latestMessageRange(client, count);
      if (range === null) {
        return [];
      }
      const messages = [];
      for await (const msg of client.fetch(range.value, fetchQuery, range.options)) {
        const flags = Array.from(msg.flags || []);
        const base = {
          uid: msg.uid,
          date: new Date(msg.internalDate || msg.envelope?.date || Date.now()),
          from: msg.envelope?.from?.[0] ? this.formatAddress(msg.envelope.from[0]) : "",
          to: msg.envelope?.to?.map((addr) => this.formatAddress(addr)) || [],
          subject: msg.envelope?.subject || "",
          messageId: msg.envelope?.messageId || "",
          inReplyTo: msg.envelope?.inReplyTo,
          flags,
          customKeywords: flags.filter((f) => !isSystemFlag(f))
        };
        if (!includeBody || !msg.source) {
          messages.push(base);
          continue;
        }
        try {
          const rendered = await this.buildEmailContentFromSource(msg.uid, msg.source, msg.flags, {
            bodyFormat: options?.bodyFormat ?? DEFAULT_BODY_FORMAT,
            bodyMaxLength,
            includeAttachmentText: false
          });
          messages.push(this.mergeBodyIntoMessage(base, rendered, options?.bodyFormat ?? DEFAULT_BODY_FORMAT));
        } catch {
          messages.push(base);
        }
      }
      return messages.sort((a, b) => b.date.getTime() - a.date.getTime());
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  formatAddress(addr) {
    if (!addr) return "";
    if (addr.name) {
      return `${addr.name} <${addr.address}>`;
    }
    return addr.address || "";
  }
  async getEmailContent(accountId, folderName, uid, options = {}) {
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const source = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
      if (!source || !source.source) {
        throw new Error(`Email with UID ${uid} not found`);
      }
      return await this.buildEmailContentFromSource(uid, source.source, source.flags, options);
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  /**
   * Parse a raw RFC822 source Buffer with mailparser and render body/header
   * fields according to `options`. Used by both `getEmailContent` (single
   * message) and the includeBody paths in `searchEmails`/`getLatestEmails`/
   * `findThreadMessages` so body rendering stays in one place.
   *
   * `bodyMaxLength` caps each populated body field independently. Search /
   * latest / thread callers pass a small cap (default 10000) to protect the
   * context window when returning many messages at once; `getEmailContent`
   * leaves it undefined so the caller-controlled `maxContentLength` (in
   * `email-tools.ts`) applies unchanged.
   */
  async buildEmailContentFromSource(uid, source, flags, options = {}) {
    const {
      includeAttachmentText = false,
      maxAttachmentTextBytes = 256 * 1024,
      maxAttachmentTextChars = 1e5,
      bodyFormat = "markdown",
      markdownThreshold = 200,
      bodyMaxLength
    } = options;
    const parsed = await simpleParser(source);
    const flagArray = Array.from(flags || []);
    const cap = (s) => {
      if (s === void 0) return void 0;
      if (bodyMaxLength === void 0 || bodyMaxLength <= 0) return s;
      return s.length > bodyMaxLength ? s.substring(0, bodyMaxLength) : s;
    };
    const rawText = parsed.text || void 0;
    const rawHtml = parsed.html || void 0;
    let textContent;
    let htmlContent;
    let markdownContent;
    if (bodyFormat === "html") {
      textContent = cap(rawText);
      htmlContent = cap(rawHtml);
    } else if (bodyFormat === "text") {
      const baseText = rawText ? normalizeWhitespace(rawText) : rawHtml ? htmlToMarkdown(rawHtml) : void 0;
      textContent = cap(baseText);
    } else {
      const cleanText = rawText ? normalizeWhitespace(rawText) : "";
      if (cleanText.length >= markdownThreshold) {
        markdownContent = cleanText;
      } else if (rawHtml) {
        markdownContent = htmlToMarkdown(rawHtml);
      } else {
        markdownContent = cleanText || void 0;
      }
      textContent = rawText;
      markdownContent = cap(markdownContent);
    }
    const textAttachmentExtensions = [".txt", ".md", ".markdown", ".csv", ".log", ".json", ".xml", ".yml", ".yaml"];
    const pdfExtensions = [".pdf"];
    const headers = {};
    if (parsed.headers) {
      const headerToString = (v) => {
        if (typeof v === "string") return v;
        if (v instanceof Date) return v.toISOString();
        if (v && typeof v === "object" && "text" in v) return String(v.text);
        if (v && typeof v === "object" && "value" in v) return String(v.value);
        if (v && typeof v === "object") return JSON.stringify(v);
        return String(v);
      };
      for (const [key, value] of parsed.headers) {
        if (typeof value === "string") {
          headers[key] = value;
        } else if (Array.isArray(value)) {
          headers[key] = value.map(headerToString);
        } else {
          headers[key] = headerToString(value);
        }
      }
    }
    return {
      uid,
      date: parsed.date || /* @__PURE__ */ new Date(),
      from: parsed.from?.text || "",
      to: parsed.to ? Array.isArray(parsed.to) ? parsed.to.map((t) => t.text || "") : [parsed.to.text || ""] : [],
      subject: parsed.subject || "",
      messageId: parsed.messageId || "",
      inReplyTo: parsed.inReplyTo,
      flags: flagArray,
      customKeywords: flagArray.filter((f) => !isSystemFlag(f)),
      headers,
      textContent,
      htmlContent,
      markdownContent,
      bodyFormat,
      attachments: await Promise.all((parsed.attachments || []).map(async (att) => {
        const filename = att.filename || "unknown";
        const contentType = att.contentType || "application/octet-stream";
        const size = att.size || 0;
        const attachment = {
          filename,
          contentType,
          size,
          contentId: att.contentId
        };
        if (!includeAttachmentText || !att?.content) {
          return attachment;
        }
        const contentTypeLower = String(contentType).toLowerCase();
        const filenameLower = String(filename).toLowerCase();
        const isTextContentType = contentTypeLower.startsWith("text/") || ["application/json", "application/xml", "application/xhtml+xml", "application/yaml", "application/x-yaml"].includes(contentTypeLower);
        const hasTextExtension = textAttachmentExtensions.some((ext) => filenameLower.endsWith(ext));
        const isTextAttachment = isTextContentType || hasTextExtension;
        const isPdf = contentTypeLower === "application/pdf" || pdfExtensions.some((ext) => filenameLower.endsWith(ext));
        if (isPdf && att?.content) {
          try {
            const { PDFParse } = await import("pdf-parse");
            const contentBuffer2 = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content);
            const pdfParser = new PDFParse({ data: contentBuffer2 });
            let rawText3;
            try {
              const pdfData = await pdfParser.getText({ pageJoiner: "" });
              rawText3 = pdfData.text;
            } finally {
              await pdfParser.destroy();
            }
            const textTruncated2 = rawText3.length > maxAttachmentTextChars;
            const textContent3 = textTruncated2 ? rawText3.slice(0, maxAttachmentTextChars) : rawText3;
            return {
              ...attachment,
              textContent: textContent3,
              textContentTruncated: textTruncated2 || void 0
            };
          } catch {
            return attachment;
          }
        }
        if (!isTextAttachment) {
          return attachment;
        }
        const contentBuffer = Buffer.isBuffer(att.content) ? att.content : void 0;
        const contentLength = contentBuffer?.length ?? (typeof att.content === "string" ? att.content.length : 0);
        if (contentLength > maxAttachmentTextBytes) {
          return attachment;
        }
        const rawText2 = contentBuffer ? contentBuffer.toString("utf8") : String(att.content);
        const textTruncated = rawText2.length > maxAttachmentTextChars;
        const textContent2 = textTruncated ? rawText2.slice(0, maxAttachmentTextChars) : rawText2;
        return {
          ...attachment,
          textContent: textContent2,
          textContentTruncated: textTruncated || void 0
        };
      }))
    };
  }
  /**
   * Merge body fields rendered by `buildEmailContentFromSource` into a
   * lightweight `EmailMessage` returned by the search / latest / thread paths.
   * Only the body fields relevant to the requested `bodyFormat` are attached
   * (raw HTML stays out unless `bodyFormat: 'html'` was requested).
   */
  mergeBodyIntoMessage(base, rendered, bodyFormat) {
    return {
      ...base,
      // Always prefer the body field the caller asked for, fall back to any
      // populated body field so a single-mode consumer never gets an empty
      // result when the message happened to only carry text/plain (markdown
      // mode returns textContent populated as a side-effect — preserve it).
      markdownContent: rendered.markdownContent,
      textContent: rendered.textContent,
      ...bodyFormat === "html" ? { htmlContent: rendered.htmlContent } : {},
      bodyFormat
    };
  }
  async getAttachmentContent(accountId, folderName, uid, filename) {
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const source = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!source || !source.source) {
        throw new Error(`Email with UID ${uid} not found`);
      }
      const parsed = await simpleParser(source.source);
      const attachment = parsed.attachments?.find(
        (att) => att.filename === filename || att.contentId === filename
      );
      if (!attachment) {
        throw new Error(`Attachment "${filename}" not found in email UID ${uid}`);
      }
      return {
        content: attachment.content,
        contentType: attachment.contentType || "application/octet-stream",
        filename: attachment.filename || "unknown"
      };
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  /**
   * Mark messages as read.
   *
   * Single-uid calls return `void` (unchanged). When `uids` is an array, the
   * IMAP server's UID sequence-set is used so all flags flip in one call.
   * Returns a per-uid report — failed UIDs are listed in `errors`, never
   * surfaced as a thrown error, so partial failure is observable.
   */
  async markAsRead(accountId, folderName, uids) {
    return this.flagBatch(accountId, folderName, uids, "add");
  }
  async markAsUnread(accountId, folderName, uids) {
    return this.flagBatch(accountId, folderName, uids, "remove");
  }
  /**
   * Add or remove the \\Seen flag on one or many UIDs in one mailbox.
   *
   * For a single UID: returns `marked: [uid]` on success. For an array, all
   * UIDs go into a single sequence-set so we hit the server with one
   * `messageFlagsAdd`/`messageFlagsRemove` call (instead of N) — that's the
   * core of the #106 batch-UIDs performance win.
   *
   * On error, the whole batch fails and the failed uid(s) are reported.
   * imapflow's `messageFlagsAdd`/`messageFlagsRemove` is atomic at the
   * IMAP-server level (one command), so partial-success handling for an
   * array is unnecessary; the IMAP server either flips them all or rejects.
   */
  async flagBatch(accountId, folderName, uids, mode) {
    const uidList2 = Array.isArray(uids) ? uids : [uids];
    if (uidList2.length === 0) {
      return { success: true, marked: [], failed: [] };
    }
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const target = uidList2.length === 1 ? uidList2[0] : uidList2.join(",");
      if (mode === "add") {
        await client.messageFlagsAdd(target, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(target, ["\\Seen"], { uid: true });
      }
      return { success: true, marked: [...uidList2], failed: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        success: false,
        marked: [],
        failed: [...uidList2],
        errors: [`Failed to ${mode === "add" ? "mark as read" : "mark as unread"} UIDs [${uidList2.join(", ")}]: ${message}`]
      };
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  async flagEmail(accountId, folderName, uid) {
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      await client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  async unflagEmail(accountId, folderName, uid) {
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      await client.messageFlagsRemove(uid, ["\\Flagged"], { uid: true });
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  async addKeyword(accountId, folderName, uid, keyword) {
    if (isSystemFlag(keyword)) {
      throw new Error(
        `"${keyword}" is a system flag, not a custom keyword. Use the dedicated tool instead (e.g. imap_flag_email for \\Flagged, imap_mark_as_read for \\Seen).`
      );
    }
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const result = await client.messageFlagsAdd(uid, [keyword], { uid: true });
      if (!result) {
        throw new Error(`Server did not apply keyword "${keyword}" to email UID ${uid} in ${folderName} (message not found or server rejected the change)`);
      }
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  async removeKeyword(accountId, folderName, uid, keyword) {
    if (isSystemFlag(keyword)) {
      throw new Error(
        `"${keyword}" is a system flag, not a custom keyword. Use the dedicated tool instead (e.g. imap_flag_email for \\Flagged, imap_mark_as_read for \\Seen).`
      );
    }
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const result = await client.messageFlagsRemove(uid, [keyword], { uid: true });
      if (!result) {
        throw new Error(`Server did not remove keyword "${keyword}" from email UID ${uid} in ${folderName} (message not found or server rejected the change)`);
      }
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  /**
   * Detect the trash folder for an IMAP account.
   *
   * Priority:
   *   1. RFC 6154 SPECIAL-USE `\Trash` flag — the server tells us itself
   *   2. Provider-specific hardcoded path (Gmail's `[Gmail]/Trash`)
   *   3. Fallback list of common trash folder names across locales
   *      (Sherweb FR Exchange uses "Éléments supprimés", not "Trash")
   *
   * Without this, a server like Sherweb would silently fail: messageMove
   * to a non-existent `Trash` folder, deleted counter incremented, but
   * messages never actually leave the source folder.
   */
  async resolveTrashFolder(accountId) {
    const client = await this.ensureConnected(accountId);
    const connState = this.connections.get(accountId);
    const isGmail = connState?.account?.host?.includes("gmail") || connState?.account?.host?.includes("google");
    try {
      const folders = await client.list();
      const trash = folders.find((f) => f.specialUse === "\\Trash");
      if (trash) return trash.path;
      if (isGmail && folders.some((f) => f.path === "[Gmail]/Trash")) {
        return "[Gmail]/Trash";
      }
      const candidates = [
        "Trash",
        "Deleted Items",
        // Exchange EN
        "Deleted Messages",
        // Apple Mail
        "\xC9l\xE9ments supprim\xE9s",
        // Exchange FR (Sherweb)
        "El\xE9ments supprim\xE9s",
        // Exchange FR no accent on É
        "Elementos eliminados",
        // Exchange ES
        "Gel\xF6schte Elemente",
        // Exchange DE
        "Elementi eliminati",
        // Exchange IT
        "Papierkorb",
        // DE classic
        "Papelera",
        // ES classic
        "Corbeille",
        // FR classic
        "INBOX.Trash"
        // Courier-IMAP
      ];
      for (const name of candidates) {
        if (folders.some((f) => f.path === name)) return name;
      }
    } catch {
    }
    return isGmail ? "[Gmail]/Trash" : "Trash";
  }
  async deleteEmail(accountId, folderName, uid) {
    const client = await this.ensureConnected(accountId);
    const trashFolder = await this.resolveTrashFolder(accountId);
    if (!trashFolder) {
      throw new Error("Cannot delete: no trash folder detected on this account");
    }
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      if (folderName === trashFolder) {
        await client.messageDelete(uid, { uid: true });
      } else {
        await client.messageMove(uid, trashFolder, { uid: true });
      }
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  async bulkDelete(accountId, folderName, uids, chunkSize = 50, onProgress) {
    const client = await this.ensureConnected(accountId);
    const trashFolder = await this.resolveTrashFolder(accountId);
    if (!trashFolder) {
      return {
        deleted: 0,
        failed: uids.length,
        errors: ["No trash folder detected on this account"]
      };
    }
    const isAlreadyInTrash = folderName === trashFolder;
    let deleted = 0;
    let failed = 0;
    const errors = [];
    for (let i = 0; i < uids.length; i += chunkSize) {
      const chunk = uids.slice(i, i + chunkSize);
      let lock;
      try {
        await this.ensureConnected(accountId);
        lock = await client.getMailboxLock(folderName);
        const uidSet = chunk.join(",");
        if (isAlreadyInTrash) {
          await client.messageDelete(uidSet, { uid: true });
        } else {
          await client.messageMove(uidSet, trashFolder, { uid: true });
        }
        deleted += chunk.length;
        if (onProgress) {
          onProgress(deleted, uids.length);
        }
      } catch (err) {
        failed += chunk.length;
        errors.push(`Failed to delete UIDs ${chunk[0]}-${chunk[chunk.length - 1]}: ${err instanceof Error ? err.message : "Unknown error"}`);
        const state = this.connections.get(accountId);
        if (state) {
          state.isConnected = false;
        }
      } finally {
        if (lock) {
          lock.release();
        }
      }
    }
    return { deleted, failed, errors };
  }
  /**
   * Move one email or a batch of emails from `folderName` to `targetFolder`.
   *
   * - Single UID (number): returns the existing single-uid shape `{ path,
   *   destination, destinationCreated?, uidMap? }` (unchanged).
   * - Array of UIDs: returns `{ path, destination, destinationCreated?,
   *   results: [{ uid, destination, uidMap? }, …] }`. Per-uid errors are
   *   reported in the result rather than thrown so partial failures are
   *   observable — a single bad UID should not lose the work done for
   *   siblings. `createDestinationIfMissing` is honored once up front.
   */
  async moveEmail(accountId, folderName, uids, targetFolder, options) {
    const isBatch = Array.isArray(uids);
    const uidList2 = isBatch ? uids : [uids];
    const client = await this.ensureConnected(accountId);
    let destinationCreated = false;
    if (options?.createDestinationIfMissing) {
      const exists = await this.folderExists(accountId, targetFolder);
      if (!exists) {
        await this.createFolder(accountId, targetFolder);
        destinationCreated = true;
      }
    }
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const results = [];
      let firstResult = null;
      let firstPath = folderName;
      for (const uid of uidList2) {
        try {
          const result = await client.messageMove(uid, targetFolder, { uid: true });
          if (!result) {
            throw new Error(`Server returned no result for UID ${uid}`);
          }
          if (!firstResult) {
            firstResult = { path: result.path, destination: result.destination, uidMap: result.uidMap };
            firstPath = result.path;
          }
          const uidMapRecord = result.uidMap ? Object.fromEntries(result.uidMap) : void 0;
          results.push({
            uid,
            destination: result.destination,
            ...uidMapRecord ? { uidMap: uidMapRecord } : {}
          });
        } catch (err) {
          if (isBatch) {
            results.push({
              uid,
              destination: targetFolder,
              uidMap: void 0
            });
            results[results.length - 1].error = err instanceof Error ? err.message : String(err);
          } else {
            throw new Error(
              `Failed to move email UID ${uid} from ${folderName} to ${targetFolder}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
      if (!isBatch) {
        return {
          path: firstResult?.path ?? firstPath,
          destination: firstResult?.destination ?? targetFolder,
          destinationCreated: destinationCreated || void 0,
          uidMap: firstResult?.uidMap
        };
      }
      return {
        path: firstResult?.path ?? firstPath,
        destination: targetFolder,
        destinationCreated: destinationCreated || void 0,
        results
      };
    } finally {
      if (lock) {
        lock.release();
      }
    }
  }
  async folderExists(accountId, folderPath) {
    const client = await this.ensureConnected(accountId);
    const list = await client.list();
    return list.some((f) => f.path === folderPath);
  }
  async createFolder(accountId, folderPath) {
    const client = await this.ensureConnected(accountId);
    try {
      const result = await client.mailboxCreate(folderPath);
      const path2 = result && typeof result === "object" && "path" in result ? result.path : folderPath;
      const created = result && typeof result === "object" && "created" in result ? Boolean(result.created) : true;
      return {
        path: path2,
        created,
        alreadyExisted: !created
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already exists|exists/i.test(message)) {
        return { path: folderPath, created: false, alreadyExisted: true };
      }
      throw new Error(`Failed to create folder "${folderPath}": ${message}`);
    }
  }
  /**
   * Find messages in `searchFolder` that belong to the same conversation
   * threads as messages already in `sourceFolder`.
   *
   * Returns `{ messageIds, uids }` and — when `options.includeBody` is true —
   * an additional `messages` array with full body for each matched UID,
   * formatted like `imap_get_email` (markdown by default). `searchReferences`
   * is honored as before (default true).
   *
   * Backwards-compatible: when `includeBody` is omitted, the returned shape
   * is identical to the previous version.
   */
  async findThreadMessages(accountId, sourceFolder, searchFolder, options) {
    const client = await this.ensureConnected(accountId);
    const includeReferences = options?.searchReferences !== false;
    const includeBody = options?.includeBody === true;
    const bodyMaxLength = options?.bodyMaxLength ?? DEFAULT_BODY_MAX_LENGTH;
    const bodyFormat = options?.bodyFormat ?? DEFAULT_BODY_FORMAT;
    const messageIds = [];
    let lock = await client.getMailboxLock(sourceFolder);
    try {
      const allUids = await client.search({ all: true }, { uid: true });
      if (allUids && allUids.length > 0) {
        for await (const msg of client.fetch(allUids, { uid: true, envelope: true }, { uid: true })) {
          if (msg.envelope?.messageId) {
            messageIds.push(msg.envelope.messageId);
          }
        }
      }
    } finally {
      lock.release();
    }
    if (messageIds.length === 0) {
      return { messageIds: [], uids: [] };
    }
    const foundUids = /* @__PURE__ */ new Set();
    lock = await client.getMailboxLock(searchFolder);
    try {
      for (const msgId of messageIds) {
        try {
          const inReplyMatches = await client.search(
            { header: { "in-reply-to": msgId } },
            { uid: true }
          );
          for (const uid of inReplyMatches || []) foundUids.add(uid);
          if (includeReferences) {
            const refMatches = await client.search(
              { header: { "references": msgId } },
              { uid: true }
            );
            for (const uid of refMatches || []) foundUids.add(uid);
          }
        } catch {
        }
      }
    } finally {
      lock.release();
    }
    const sortedUids = Array.from(foundUids).sort((a, b) => a - b);
    if (!includeBody || sortedUids.length === 0) {
      return { messageIds, uids: sortedUids };
    }
    const messages = [];
    lock = await client.getMailboxLock(searchFolder);
    try {
      const fetchQuery = {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        source: true
      };
      for await (const msg of client.fetch(sortedUids, fetchQuery, { uid: true })) {
        const flags = Array.from(msg.flags || []);
        const base = {
          uid: msg.uid,
          date: new Date(msg.internalDate || msg.envelope?.date || Date.now()),
          from: msg.envelope?.from?.[0] ? this.formatAddress(msg.envelope.from[0]) : "",
          to: msg.envelope?.to?.map((addr) => this.formatAddress(addr)) || [],
          subject: msg.envelope?.subject || "",
          messageId: msg.envelope?.messageId || "",
          inReplyTo: msg.envelope?.inReplyTo,
          flags,
          customKeywords: flags.filter((f) => !isSystemFlag(f))
        };
        if (!msg.source) {
          messages.push({ ...base, bodyFormat });
          continue;
        }
        try {
          const rendered = await this.buildEmailContentFromSource(msg.uid, msg.source, msg.flags, {
            bodyFormat,
            bodyMaxLength,
            includeAttachmentText: false
          });
          messages.push(this.mergeBodyIntoMessage(base, rendered, bodyFormat));
        } catch {
          messages.push({ ...base, bodyFormat });
        }
      }
    } finally {
      lock.release();
    }
    return { messageIds, uids: sortedUids, messages };
  }
  /**
   * Append a sent message to the account's Sent folder.
   *
   * Resolution order: explicit `sentFolderOverride` (the account's configured
   * `sentFolder`) → SPECIAL-USE `\Sent` flag → localized-name fallback list.
   * Returns a structured result so callers can report *why* a save failed
   * instead of a bare `false` (issue #125).
   */
  async appendToSentFolder(accountId, rawMessage, sentFolderOverride) {
    const sentFolderNames = [
      // English / standard
      "Sent Messages",
      "Sent",
      "INBOX.Sent",
      "Sent Items",
      "Sent Mail",
      "[Gmail]/Sent Mail",
      // French (Outlook / Exchange / Sherweb)
      "\xC9l\xE9ments envoy\xE9s",
      "El\xE9ments envoy\xE9s",
      "Messages envoy\xE9s",
      // German
      "Gesendet",
      "Gesendete Elemente",
      "Gesendete Objekte",
      "[Gmail]/Gesendet",
      // Spanish
      "Enviados",
      "Elementos enviados",
      // Portuguese
      "Enviados",
      "Itens Enviados",
      // Italian
      "Inviati",
      "Posta inviata",
      // Dutch
      "Verzonden",
      "Verzonden items"
    ];
    let folder = sentFolderOverride;
    if (!folder) {
      folder = await this.findSpecialUseFolder(accountId, "\\Sent", sentFolderNames);
    }
    if (!folder) {
      const error = "No Sent folder found: the server advertises no \\Sent SPECIAL-USE folder and no folder matched the known localized names. Use imap_list_folders to find the right folder and set it as the account's sentFolder (imap_update_account).";
      console.warn(`[IMAP] ${error} (account ${accountId}; names tried: ${sentFolderNames.join(", ")})`);
      return { saved: false, error };
    }
    try {
      const client = await this.ensureConnected(accountId);
      await client.append(folder, rawMessage, ["\\Seen"]);
      return { saved: true, folder };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[IMAP] Failed to append sent copy to "${folder}": ${reason}`);
      const hint = sentFolderOverride ? " The account's configured sentFolder may not exist on the server \u2014 check it with imap_list_folders." : "";
      return { saved: false, folder, error: `Failed to append to "${folder}": ${reason}.${hint}` };
    }
  }
  async findFolderByNames(accountId, candidates) {
    const folders = await this.listFolders(accountId);
    return folders.find((f) => candidates.includes(f.name))?.name;
  }
  /**
   * Find a folder by IMAP SPECIAL-USE flag (RFC 6154) first, with fallback
   * to a list of localized folder names.
   *
   * SPECIAL-USE flags (\Sent, \Drafts, \Trash, \Junk, \Archive) are language-
   * independent and work with any IMAP server that advertises them. This
   * resolves localized folder names (e.g. "Éléments envoyés" on Sherweb /
   * Outlook FR) without needing to hardcode every language.
   *
   * Fallback to name list keeps backward compatibility with older servers
   * that don't advertise SPECIAL-USE flags.
   */
  async findSpecialUseFolder(accountId, specialUseFlag, fallbackNames) {
    const folders = await this.listFolders(accountId);
    const target = specialUseFlag.toLowerCase();
    const specialUseMatch = folders.find((f) => f.specialUse?.toLowerCase() === target);
    if (specialUseMatch) {
      return specialUseMatch.name;
    }
    const flagMatch = folders.find(
      (f) => f.attributes.some((a) => typeof a === "string" && a.toLowerCase() === target)
    );
    if (flagMatch) {
      return flagMatch.name;
    }
    return folders.find((f) => fallbackNames.includes(f.name))?.name;
  }
  async findDraftsFolder(accountId) {
    const draftsFolderNames = [
      // English
      "Drafts",
      "Draft",
      "INBOX.Drafts",
      "INBOX.Draft",
      "[Gmail]/Drafts",
      // French
      "Brouillons",
      // German
      "Entw\xFCrfe",
      // Spanish
      "Borradores",
      // Portuguese
      "Rascunhos",
      // Italian
      "Bozze",
      // Dutch
      "Concepten"
    ];
    return this.findSpecialUseFolder(accountId, "\\Drafts", draftsFolderNames);
  }
  async appendMessage(accountId, folder, rawMessage, flags) {
    const client = await this.ensureConnected(accountId);
    try {
      await client.append(folder, rawMessage, flags ?? []);
      return true;
    } catch (err) {
      console.error(`[IMAP] Failed to append to ${folder}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
  async testConnection(account) {
    const testClient = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.tls,
      // Validate the certificate against the host we actually dial; see connect().
      tls: { host: account.host },
      auth: {
        user: account.user,
        pass: account.password,
        loginMethod: account.loginMethod
      },
      logger: false
    });
    try {
      await testClient.connect();
      const folderList = await testClient.list();
      const folders = folderList.map((f) => f.path);
      let messageCount = 0;
      try {
        const inbox = await testClient.status("INBOX", { messages: true });
        messageCount = inbox.messages || 0;
      } catch {
      }
      await testClient.logout();
      return {
        success: true,
        folders,
        messageCount
      };
    } catch (err) {
      return {
        success: false,
        error: enrichConnectionError(err, account.host)
      };
    }
  }
  buildSearchQuery(criteria) {
    const query = {};
    if (criteria.from) {
      query.from = criteria.from;
    }
    if (criteria.to) {
      query.to = criteria.to;
    }
    if (criteria.subject) {
      query.subject = criteria.subject;
    }
    if (criteria.body) {
      query.body = criteria.body;
    }
    if (criteria.since) {
      query.since = criteria.since;
    }
    if (criteria.before) {
      query.before = criteria.before;
    }
    if (criteria.seen !== void 0) {
      query.seen = criteria.seen;
    }
    if (criteria.flagged !== void 0) {
      query.flagged = criteria.flagged;
    }
    if (criteria.answered !== void 0) {
      query.answered = criteria.answered;
    }
    if (criteria.draft !== void 0) {
      query.draft = criteria.draft;
    }
    if (criteria.messageId) {
      query.header = { "message-id": this.bracketMessageId(criteria.messageId) };
    }
    if (criteria.keywords && criteria.keywords.length > 0) {
      for (const keyword of criteria.keywords) {
        if (isSystemFlag(keyword)) {
          throw new Error(
            `"${keyword}" is a system flag, not a custom keyword. Use the dedicated params instead (e.g. flagged for \\Flagged, seen for \\Seen).`
          );
        }
      }
      if (criteria.keywords.length === 1) {
        query.keyword = criteria.keywords[0];
      } else {
        query.or = criteria.keywords.map((keyword) => ({ keyword }));
      }
    }
    if (criteria.unKeywords && criteria.unKeywords.length > 0) {
      for (const keyword of criteria.unKeywords) {
        if (isSystemFlag(keyword)) {
          throw new Error(
            `"${keyword}" is a system flag, not a custom keyword. Use the dedicated params instead (e.g. flagged for \\Flagged, seen for \\Seen).`
          );
        }
      }
      if (criteria.unKeywords.length === 1) {
        query.unKeyword = criteria.unKeywords[0];
      } else {
        query.not = { or: criteria.unKeywords.map((keyword) => ({ keyword })) };
      }
    }
    if (Object.keys(query).length === 0) {
      return { all: true };
    }
    return query;
  }
  normalizeMessageId(id) {
    if (!id) return "";
    return id.trim().replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
  }
  /** Full bracketed Message-ID for IMAP HEADER search (case preserved). */
  bracketMessageId(id) {
    const bare = String(id || "").trim().replace(/^<+/, "").replace(/>+$/, "").trim();
    return bare ? `<${bare}>` : "";
  }
  flattenFolders(folders) {
    const out = [];
    for (const f of folders) {
      out.push(f);
      if (f.children?.length) out.push(...this.flattenFolders(f.children));
    }
    return out;
  }
  /**
   * Folder search order for findEmailByMessageId. Gmail: the \All mailbox
   * ([Gmail]/All Mail) holds every message regardless of label, so it alone
   * finds archived/moved mail (\All excludes Trash/Spam, included explicitly).
   * Generic IMAP: INBOX → \Archive → \Sent → remaining selectable folders.
   */
  async resolveFolderSearchOrder(accountId) {
    const flat = this.flattenFolders(await this.listFolders(accountId));
    const hasFlag = (f, flag) => (f.attributes || []).some((a) => a.toLowerCase() === flag.toLowerCase());
    const allMail = flat.find((f) => hasFlag(f, "\\All"));
    if (allMail) {
      return [
        allMail.name,
        flat.find((f) => hasFlag(f, "\\Trash"))?.name,
        flat.find((f) => hasFlag(f, "\\Junk"))?.name
      ].filter(Boolean);
    }
    const order = [];
    const pushOnce = (name) => {
      if (name && !order.includes(name)) order.push(name);
    };
    pushOnce(flat.find((f) => f.name.toUpperCase() === "INBOX")?.name);
    pushOnce(flat.find((f) => hasFlag(f, "\\Archive"))?.name);
    pushOnce(flat.find((f) => hasFlag(f, "\\Sent"))?.name);
    for (const f of flat) {
      if (hasFlag(f, "\\Noselect")) continue;
      pushOnce(f.name);
    }
    return order;
  }
  /**
   * Locate a message by its RFC822 Message-ID across folders and return its
   * current { folder, uid }. Robust to the message having been moved/archived
   * (IMAP UIDs are folder-relative). Returns found:false if nowhere located.
   */
  async findEmailByMessageId(accountId, messageId, folders) {
    const target = this.normalizeMessageId(messageId);
    if (!target) return { found: false, foldersSearched: [] };
    const MAX_FOLDERS = 25;
    const order = (folders && folders.length > 0 ? folders : await this.resolveFolderSearchOrder(accountId)).slice(0, MAX_FOLDERS);
    const foldersSearched = [];
    for (const folder of order) {
      foldersSearched.push(folder);
      let candidates;
      try {
        candidates = await this.searchEmails(accountId, folder, { messageId });
      } catch {
        continue;
      }
      for (const msg of candidates) {
        if (this.normalizeMessageId(msg.messageId) === target) {
          return {
            found: true,
            folder,
            uid: msg.uid,
            messageId: msg.messageId,
            subject: msg.subject,
            from: msg.from,
            date: msg.date,
            flags: msg.flags,
            customKeywords: msg.customKeywords,
            foldersSearched
          };
        }
      }
    }
    return { found: false, foldersSearched };
  }
};

// src/services/account-manager.ts
import { promises as fs } from "fs";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
var AccountManager = class _AccountManager {
  configPath;
  accounts = /* @__PURE__ */ new Map();
  encryptionKey;
  capturedEnvOverrides = /* @__PURE__ */ new Map();
  static ENV_OVERRIDE_PATTERN = /^IMAP_MCP_ACCOUNT_.+_(?:IMAP|SMTP)_(?:USERNAME|PASSWORD)$/;
  constructor() {
    this.configPath = path.join(os.homedir(), ".imap-mcp", "accounts.json");
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.captureEnvOverrides();
    this.loadAccountsSync();
  }
  async addAccount(account) {
    const id = crypto.randomUUID();
    const newAccount = {
      ...account,
      id,
      password: this.encrypt(account.password)
    };
    if (account.smtp?.password) {
      newAccount.smtp = {
        ...account.smtp,
        password: this.encrypt(account.smtp.password)
      };
    }
    this.accounts.set(id, newAccount);
    await this.saveAccounts();
    return { ...newAccount, password: account.password, smtp: account.smtp };
  }
  async removeAccount(id) {
    if (!this.accounts.has(id)) {
      throw new Error(`Account ${id} not found`);
    }
    this.accounts.delete(id);
    await this.saveAccounts();
  }
  async updateAccount(id, updates) {
    const existingAccount = this.accounts.get(id);
    if (!existingAccount) {
      throw new Error(`Account with id ${id} not found`);
    }
    const processedUpdates = { ...updates };
    if (processedUpdates.password !== void 0) {
      processedUpdates.password = this.encrypt(processedUpdates.password);
    }
    if (processedUpdates.smtp?.password) {
      processedUpdates.smtp = {
        ...processedUpdates.smtp,
        password: this.encrypt(processedUpdates.smtp.password)
      };
    }
    const updatedAccount = {
      ...existingAccount,
      ...processedUpdates,
      id
      // Ensure ID doesn't change
    };
    this.accounts.set(id, updatedAccount);
    await this.saveAccounts();
    const decrypted = {
      ...updatedAccount,
      password: this.decrypt(updatedAccount.password)
    };
    if (updatedAccount.smtp?.password) {
      decrypted.smtp = {
        ...updatedAccount.smtp,
        password: this.decrypt(updatedAccount.smtp.password)
      };
    }
    return decrypted;
  }
  getAccount(id) {
    this.loadAccountsSync();
    const account = this.accounts.get(id);
    if (!account) return void 0;
    const decrypted = {
      ...account,
      password: this.decryptField(account.password)
    };
    if (account.smtp?.password) {
      decrypted.smtp = {
        ...account.smtp,
        password: this.decryptField(account.smtp.password)
      };
    }
    return this.applyEnvOverrides(decrypted);
  }
  /**
   * Override IMAP/SMTP credentials from environment variables, keyed by the
   * account's normalized name. This lets credentials be supplied at runtime
   * (e.g. from a secret manager) instead of the encrypted `accounts.json`.
   *
   *   IMAP_MCP_ACCOUNT_<NAME>_IMAP_USERNAME  -> user
   *   IMAP_MCP_ACCOUNT_<NAME>_IMAP_PASSWORD  -> password
   *   IMAP_MCP_ACCOUNT_<NAME>_SMTP_USERNAME  -> smtp.user  (only if smtp exists)
   *   IMAP_MCP_ACCOUNT_<NAME>_SMTP_PASSWORD  -> smtp.password (only if smtp exists)
   *
   * <NAME> is the account name uppercased with every non-alphanumeric character
   * replaced by "_". Overrides are applied in-memory only; nothing is written
   * back to disk. A variable takes effect only when it was present at startup.
   *
   * The values themselves are captured once in the constructor (see
   * `captureEnvOverrides`) and served here from the encrypted cache.
   */
  applyEnvOverrides(account) {
    const varName = (suffix) => envVarName(account.name, suffix);
    const result = { ...account };
    const imapUser = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.imapUser));
    if (imapUser !== void 0) {
      result.user = imapUser;
    }
    const imapPassword = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.imapPassword));
    if (imapPassword !== void 0) {
      result.password = imapPassword;
    }
    if (result.smtp) {
      const smtpUser = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.smtpUser));
      const smtpPassword = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.smtpPassword));
      if (smtpUser !== void 0 || smtpPassword !== void 0) {
        result.smtp = { ...result.smtp };
        if (smtpUser !== void 0) {
          result.smtp.user = smtpUser;
        }
        if (smtpPassword !== void 0) {
          result.smtp.password = smtpPassword;
        }
      }
    }
    return result;
  }
  /**
   * Capture every `IMAP_MCP_ACCOUNT_*_(IMAP|SMTP)_(USERNAME|PASSWORD)` variable
   * into an encrypted in-memory cache and delete it from `process.env`. Run once
   * in the constructor so the plaintext secrets do not linger in the process
   * environment (where they could leak to child processes or diagnostics) any
   * longer than necessary. `Object.entries` snapshots the keys, so deleting
   * during iteration is safe.
   */
  captureEnvOverrides() {
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== void 0 && _AccountManager.ENV_OVERRIDE_PATTERN.test(name)) {
        this.capturedEnvOverrides.set(this.hashCacheKey(name), this.encrypt(value));
        delete process.env[name];
      }
    }
  }
  /**
   * Return a captured override value by variable name, decrypting it from the
   * cache. Returns `undefined` when no such variable was present at startup.
   */
  getEnvOverride(name) {
    const encrypted = this.capturedEnvOverrides.get(this.hashCacheKey(name));
    if (encrypted === void 0) {
      return void 0;
    }
    return this.decrypt(encrypted);
  }
  /**
   * Derive a deterministic, non-reversible cache key from a variable name via
   * HMAC-SHA256 keyed by the encryption key. Keeps the account name (embedded in
   * the variable name) out of the in-memory cache in plaintext while still
   * allowing lookups.
   */
  hashCacheKey(name) {
    return crypto.createHmac("sha256", Buffer.from(this.encryptionKey, "hex")).update(name).digest("hex");
  }
  getAllAccounts() {
    return Array.from(this.accounts.values()).map((account) => {
      const decrypted = {
        ...account,
        password: this.decryptField(account.password)
      };
      if (account.smtp?.password) {
        decrypted.smtp = {
          ...account.smtp,
          password: this.decryptField(account.smtp.password)
        };
      }
      return this.applyEnvOverrides(decrypted);
    });
  }
  /**
   * Resolve which account a tool call refers to, in a backward-compatible way:
   *   1. explicit `accountId`        → must exist
   *   2. explicit `accountName`      → matched by name
   *   3. neither, and exactly ONE account configured → that account (default)
   * Throws a helpful, actionable error otherwise. Returns the account id.
   */
  resolveAccountId(accountId, accountName) {
    this.loadAccountsSync();
    if (accountId) {
      if (!this.accounts.has(accountId)) {
        throw new Error(`Account ${accountId} not found. Use imap_list_accounts to see available accounts.`);
      }
      return accountId;
    }
    if (accountName) {
      const match = Array.from(this.accounts.values()).find((acc) => acc.name === accountName);
      if (!match) {
        throw new Error(`No account named "${accountName}". Use imap_list_accounts to see available accounts.`);
      }
      return match.id;
    }
    const all = Array.from(this.accounts.values());
    if (all.length === 1) {
      return all[0].id;
    }
    if (all.length === 0) {
      throw new Error("No accounts configured. Add one with imap_add_account (or run the setup wizard).");
    }
    throw new Error(
      `Multiple accounts are configured (${all.length}). Specify accountId or accountName. Use imap_list_accounts to see them.`
    );
  }
  getAccountByName(name) {
    const account = Array.from(this.accounts.values()).find((acc) => acc.name === name);
    if (!account) return void 0;
    const decrypted = {
      ...account,
      password: this.decryptField(account.password)
    };
    if (account.smtp?.password) {
      decrypted.smtp = {
        ...account.smtp,
        password: this.decryptField(account.smtp.password)
      };
    }
    return this.applyEnvOverrides(decrypted);
  }
  loadAccountsSync() {
    try {
      const data = readFileSync(this.configPath, "utf-8");
      const accounts = JSON.parse(data);
      this.accounts.clear();
      for (const account of accounts) {
        this.accounts.set(account.id, account);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Error loading accounts:", error);
      }
    }
  }
  async saveAccounts() {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true, mode: 448 });
    const accounts = Array.from(this.accounts.values());
    await fs.writeFile(this.configPath, JSON.stringify(accounts, null, 2), { mode: 384 });
    await this.enforceStorePermissions();
  }
  /**
   * Defence in depth for the credential store. `~/.imap-mcp/` holds the raw
   * AES-256 key and the (encrypted) accounts, so anyone able to read the key
   * plus the store can recover every password. The `mode` options above only
   * apply when a file is *created*; a store written before this hardening — or
   * under a permissive umask — could still be world-readable. Re-assert
   * owner-only permissions on the directory, the accounts file, and the key.
   * Best effort: silently ignored on platforms without POSIX modes (Windows)
   * or when a path does not exist yet.
   */
  async enforceStorePermissions() {
    if (process.platform === "win32") return;
    const dir = path.dirname(this.configPath);
    const keyPath = path.join(dir, ".key");
    const targets = [
      [dir, 448],
      [this.configPath, 384],
      [keyPath, 384]
    ];
    for (const [target, mode] of targets) {
      try {
        await fs.chmod(target, mode);
      } catch {
      }
    }
  }
  getOrCreateEncryptionKey() {
    const keyPath = path.join(os.homedir(), ".imap-mcp", ".key");
    try {
      return readFileSync(keyPath, "utf-8");
    } catch {
      const key = crypto.randomBytes(32).toString("hex");
      mkdirSync(path.dirname(keyPath), { recursive: true, mode: 448 });
      writeFileSync(keyPath, key, { mode: 384 });
      return key;
    }
  }
  encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      Buffer.from(this.encryptionKey, "hex"),
      iv
    );
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  }
  /**
   * Decrypt a stored credential field.
   *
   * A missing or empty value (null, undefined, or "") is treated as "no
   * credential" and returns an empty string — the env-override mechanism can
   * still fill it at runtime. A non-empty value that is not a well-formed
   * encrypted string (missing the "iv:ciphertext" separator, or otherwise
   * undecryptable) is a corrupt entry and throws, rather than being silently
   * swallowed.
   */
  decryptField(value) {
    if (value === void 0 || value === null || value === "") {
      return "";
    }
    if (typeof value !== "string" || !value.includes(":")) {
      throw new Error("Cannot decrypt credential field: value is not a valid encrypted string");
    }
    return this.decrypt(value);
  }
  decrypt(text) {
    const [ivHex, encrypted] = text.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(this.encryptionKey, "hex"),
      iv
    );
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }
};

// src/services/smtp-service.ts
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

// src/utils/array-input.ts
var unquote = (item) => {
  const quote = item[0];
  if (item.length >= 2 && (quote === '"' || quote === "'") && item.endsWith(quote)) {
    return item.slice(1, -1).trim();
  }
  return item;
};
var fromJson = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((item) => typeof item === "string" || typeof item === "number")) return null;
  return parsed;
};
var fromBracketedList = (text) => {
  const inner = text.slice(1, -1).trim();
  if (!inner) return null;
  const items = inner.split(",").map((item) => unquote(item.trim()));
  if (items.some((item) => item.length === 0)) return null;
  return items;
};
function parseSerializedArray(value, field) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return value;
  const items = fromJson(trimmed) ?? fromBracketedList(trimmed);
  if (!items) return value;
  console.error(
    `[imap-mcp] "${field}" arrived as a stringified array; recovered ${items.length} item(s). Your MCP client serialized an array argument into a string. Passing a single comma-separated string avoids this.`
  );
  return items;
}

// src/services/smtp-service.ts
var SmtpService = class _SmtpService {
  transporters = /* @__PURE__ */ new Map();
  async createTransporter(account) {
    if (this.transporters.has(account.id)) {
      return this.transporters.get(account.id);
    }
    assertCredentialsResolved(account, "smtp");
    const smtpConfig = account.smtp || this.getDefaultSmtpConfig(account);
    const { secure, requireTLS } = this.resolveTlsMode(smtpConfig.port, smtpConfig.secure);
    const transporterOptions = {
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure,
      requireTLS,
      auth: {
        user: smtpConfig.user || account.user,
        pass: smtpConfig.password || account.password
      },
      tls: smtpConfig.tls
    };
    const transporter = nodemailer.createTransport(transporterOptions);
    await transporter.verify();
    this.transporters.set(account.id, transporter);
    return transporter;
  }
  // Port 465 is implicit TLS (SMTPS); 587/25 are submission ports that upgrade via STARTTLS.
  // A stored `secure: true` on port 587 is almost always a UI mistake — normalize it.
  resolveTlsMode(port, secure) {
    if (port === 465) return { secure: true, requireTLS: false };
    if (port === 587 || port === 25) return { secure: false, requireTLS: true };
    return { secure, requireTLS: !secure };
  }
  getDefaultSmtpConfig(account) {
    const commonProviders = {
      "imap.gmail.com": {
        host: "smtp.gmail.com",
        port: 587,
        secure: false
      },
      "outlook.office365.com": {
        host: "smtp.office365.com",
        port: 587,
        secure: false
      },
      "imap-mail.outlook.com": {
        host: "smtp-mail.outlook.com",
        port: 587,
        secure: false
      },
      "imap.mail.yahoo.com": {
        host: "smtp.mail.yahoo.com",
        port: 587,
        secure: false
      },
      "imap.aol.com": {
        host: "smtp.aol.com",
        port: 587,
        secure: false
      },
      "imap.fastmail.com": {
        host: "smtp.fastmail.com",
        port: 587,
        secure: false
      },
      "imap.zoho.com": {
        host: "smtp.zoho.com",
        port: 465,
        secure: true
      },
      "imappro.zoho.com": {
        host: "smtppro.zoho.com",
        port: 465,
        secure: true
      }
    };
    const providerConfig = commonProviders[account.host];
    if (providerConfig) {
      return providerConfig;
    }
    const smtpHost = account.host.startsWith("imap.") || account.host.startsWith("imap-") ? account.host.replace(/^imap[.-]/, (m) => m === "imap." ? "smtp." : "smtp-") : account.host;
    return {
      host: smtpHost,
      port: 587,
      secure: false
    };
  }
  // Last line of defense against an address list that was serialized into a
  // string somewhere between the caller and here (see utils/array-input.ts).
  // nodemailer would otherwise fold the literal brackets into the first and
  // last address and every recipient bounces, so recover the array instead.
  static addresses(value, field) {
    return parseSerializedArray(value, field);
  }
  toMailOptions(account, email) {
    const references = _SmtpService.addresses(email.references, "references");
    return {
      from: email.from || account.email || account.user,
      to: _SmtpService.addresses(email.to, "to"),
      cc: _SmtpService.addresses(email.cc, "cc"),
      bcc: _SmtpService.addresses(email.bcc, "bcc"),
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments?.map((att) => ({
        filename: att.filename,
        content: att.content,
        path: att.path,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        cid: att.cid
      })),
      replyTo: email.replyTo,
      inReplyTo: email.inReplyTo,
      references: Array.isArray(references) ? references.join(" ") : references
    };
  }
  // Build the raw RFC 822 message without sending. Used for drafts and Sent-folder copies.
  async composeRaw(account, email) {
    const compiled = new MailComposer(this.toMailOptions(account, email));
    return compiled.compile().build();
  }
  async sendEmail(accountId, account, email) {
    try {
      const transporter = await this.createTransporter(account);
      const mailOptions = this.toMailOptions(account, email);
      let rawMessage;
      try {
        rawMessage = await this.composeRaw(account, email);
      } catch {
      }
      const info = await transporter.sendMail(mailOptions);
      return { messageId: info.messageId, rawMessage };
    } catch (error) {
      throw new Error(`Failed to send email: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
  async verifySmtpConnection(account) {
    try {
      const transporter = await this.createTransporter(account);
      await transporter.verify();
      return true;
    } catch (error) {
      return false;
    }
  }
  disconnect(accountId) {
    const transporter = this.transporters.get(accountId);
    if (transporter) {
      transporter.close();
      this.transporters.delete(accountId);
    }
  }
  disconnectAll() {
    for (const [accountId, transporter] of this.transporters) {
      transporter.close();
    }
    this.transporters.clear();
  }
};

// src/services/spam-service.ts
var KNOWN_SPAM_DOMAINS = /* @__PURE__ */ new Set([
  // Disposable email services
  "tempmail.com",
  "temp-mail.org",
  "guerrillamail.com",
  "guerrillamail.org",
  "guerrillamail.net",
  "sharklasers.com",
  "mailinator.com",
  "maildrop.cc",
  "dispostable.com",
  "throwaway.email",
  "throwawaymail.com",
  "fakeinbox.com",
  "trashmail.com",
  "trashmail.net",
  "trashmail.org",
  "10minutemail.com",
  "10minutemail.net",
  "minutemail.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "mailnesia.com",
  "getnada.com",
  "nada.email",
  "tempail.com",
  "emailondeck.com",
  "mohmal.com",
  "tmpmail.org",
  "tmpmail.net",
  "tempr.email",
  "discard.email",
  "discardmail.com",
  "spamgourmet.com",
  "mailcatch.com",
  "mytrashmail.com",
  "jetable.org",
  "spambox.us",
  "spam4.me",
  "grr.la",
  "anonaddy.me",
  "simplelogin.co",
  "duck.com",
  // Note: DuckDuckGo's email protection - may be legitimate
  "relay.firefox.com",
  // Common spam domains
  "example.com",
  "test.com",
  "spam.com",
  "junk.com",
  // Known phishing domains (examples)
  "secure-login-verify.com",
  "account-verify-secure.com",
  "login-secure-verify.com"
]);
var SUSPICIOUS_PATTERNS = [
  /^[a-z0-9]{20,}\.(com|net|org)$/i,
  // Very long random domains
  /\d{5,}/,
  // Domains with many consecutive numbers
  /(secure|verify|login|account|update|confirm|suspend).*\d+/i,
  // Phishing-like patterns
  /^(xn--)/i
  // Punycode domains (internationalized, often used in phishing)
];
var BULK_MAILER_SIGNATURES = [
  "sendy",
  "phpmailer",
  "phplist",
  "powermta",
  "acelle",
  "sendblaster",
  "mumara",
  "gammadyne",
  "advanced mass sender",
  "atomic mail sender",
  "turbo-mailer",
  "mass mailer",
  "bulk mailer",
  "x-bulkmailer",
  "easymail"
];
var SpamService = class {
  customSpamDomains = /* @__PURE__ */ new Set();
  customWhitelistDomains = /* @__PURE__ */ new Set();
  constructor() {
    this.loadCustomDomains();
  }
  loadCustomDomains() {
    const customSpam = process.env.IMAP_SPAM_DOMAINS;
    if (customSpam) {
      customSpam.split(",").forEach((d) => this.customSpamDomains.add(d.trim().toLowerCase()));
    }
    const whitelist = process.env.IMAP_WHITELIST_DOMAINS;
    if (whitelist) {
      whitelist.split(",").forEach((d) => this.customWhitelistDomains.add(d.trim().toLowerCase()));
    }
  }
  extractDomain(email) {
    const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
    if (match) {
      const parts = match[1].split("@");
      if (parts.length === 2) {
        return parts[1].toLowerCase();
      }
    }
    return null;
  }
  checkEmail(email) {
    const domain = this.extractDomain(email);
    if (!domain) {
      return {
        email,
        domain: "unknown",
        isSpam: false,
        reason: "Could not extract domain",
        confidence: "low"
      };
    }
    if (this.customWhitelistDomains.has(domain)) {
      return {
        email,
        domain,
        isSpam: false,
        reason: "Domain is whitelisted",
        confidence: "high"
      };
    }
    if (KNOWN_SPAM_DOMAINS.has(domain) || this.customSpamDomains.has(domain)) {
      return {
        email,
        domain,
        isSpam: true,
        reason: "Known spam/disposable email domain",
        confidence: "high"
      };
    }
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(domain)) {
        return {
          email,
          domain,
          isSpam: true,
          reason: `Domain matches suspicious pattern: ${pattern.source}`,
          confidence: "medium"
        };
      }
    }
    return {
      email,
      domain,
      isSpam: false,
      confidence: "low"
    };
  }
  checkEmails(emails) {
    const results = emails.map((e) => ({
      ...this.checkEmail(e.from),
      uid: e.uid,
      subject: e.subject
    }));
    const spam = results.filter((r) => r.isSpam);
    const clean = results.filter((r) => !r.isSpam);
    const domainMap = /* @__PURE__ */ new Map();
    for (const email of emails) {
      const domain = this.extractDomain(email.from) || "unknown";
      if (!domainMap.has(domain)) {
        domainMap.set(domain, { domain, count: 0, emails: [] });
      }
      const stats = domainMap.get(domain);
      stats.count++;
      stats.emails.push({ uid: email.uid, from: email.from, subject: email.subject });
    }
    const domainStats = Array.from(domainMap.values()).sort((a, b) => b.count - a.count);
    return { spam, clean, domainStats };
  }
  /**
   * Run deterministic, dependency-free checks over an email's raw headers and
   * return any spam indicators found. Pure string/regex matching — no external
   * lookups, no DNS, no message body needed.
   *
   * @param headers    Header map with **lowercased** header names as keys and
   *                   the raw header value as string (multi-valued headers may
   *                   be joined with newlines).
   * @param fromAddress The message's From value (e.g. "Name <a@b.com>"), used
   *                   for the domain-mismatch checks.
   */
  checkHeaders(headers, fromAddress) {
    const flags = [];
    const get = (name) => {
      const v = headers[name.toLowerCase()];
      return typeof v === "string" && v.trim() !== "" ? v.trim() : void 0;
    };
    const mailerHeader = get("x-mailer") ? "X-Mailer" : get("user-agent") ? "User-Agent" : void 0;
    const mailer = get("x-mailer") || get("user-agent");
    if (mailer && mailerHeader) {
      const lower = mailer.toLowerCase();
      const hit = BULK_MAILER_SIGNATURES.find((sig) => lower.includes(sig));
      if (hit) {
        flags.push({
          header: mailerHeader,
          value: mailer,
          reason: `Known bulk/mass-mail tool (${hit})`,
          severity: "medium"
        });
      }
    }
    const precedence = get("precedence");
    if (precedence) {
      const p = precedence.toLowerCase();
      if (p === "bulk" || p === "junk") {
        flags.push({
          header: "Precedence",
          value: precedence,
          reason: "Mass-mail marker",
          severity: "low"
        });
      } else if (p === "list" && !get("list-id") && !get("list-unsubscribe")) {
        flags.push({
          header: "Precedence",
          value: precedence,
          reason: "List precedence without mailing-list headers",
          severity: "low"
        });
      }
    }
    const auth = get("authentication-results");
    if (auth) {
      const a = auth.toLowerCase();
      const dmarc = a.match(/dmarc=(none|fail|permerror|temperror)/);
      if (dmarc) {
        const fail = dmarc[1] !== "none";
        flags.push({
          header: "Authentication-Results",
          value: `dmarc=${dmarc[1]}`,
          reason: fail ? "DMARC did not pass" : "No/absent DMARC alignment",
          severity: fail ? "high" : "medium"
        });
      }
      const spf = a.match(/spf=(fail|softfail)/);
      if (spf) {
        flags.push({
          header: "Authentication-Results",
          value: `spf=${spf[1]}`,
          reason: spf[1] === "fail" ? "SPF failed" : "SPF softfail",
          severity: spf[1] === "fail" ? "high" : "medium"
        });
      }
      if (/dkim=fail/.test(a)) {
        flags.push({
          header: "Authentication-Results",
          value: "dkim=fail",
          reason: "DKIM signature failed",
          severity: "medium"
        });
      }
    }
    const fromDomain = fromAddress ? this.extractDomain(fromAddress) : null;
    const listUnsub = get("list-unsubscribe");
    if (listUnsub && fromDomain) {
      const hosts = this.extractHeaderHosts(listUnsub);
      if (hosts.length > 0 && !hosts.some((h) => this.domainsRelated(h, fromDomain))) {
        flags.push({
          header: "List-Unsubscribe",
          value: listUnsub.length > 200 ? `${listUnsub.slice(0, 200)}\u2026` : listUnsub,
          reason: `Unsubscribe host (${hosts.join(", ")}) unrelated to sender domain (${fromDomain})`,
          severity: "low"
        });
      }
    }
    const replyTo = get("reply-to");
    if (replyTo && fromDomain) {
      const replyDomain = this.extractDomain(replyTo);
      if (replyDomain && !this.domainsRelated(replyDomain, fromDomain)) {
        flags.push({
          header: "Reply-To",
          value: replyTo,
          reason: `Reply-To domain (${replyDomain}) differs from From domain (${fromDomain})`,
          severity: "low"
        });
      }
    }
    return flags;
  }
  /**
   * Two hostnames are considered "related" when they are equal or one is a
   * subdomain of the other (e.g. `mail.firma.de` vs `firma.de`). Deterministic
   * suffix comparison — deliberately simpler than a full public-suffix lookup,
   * which keeps it dependency-free while catching the common ESP-vs-sender case.
   */
  domainsRelated(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  }
  /**
   * Extract hostnames from a header value containing http(s) URLs and/or
   * `mailto:` addresses (e.g. a List-Unsubscribe header). Ports and paths are
   * stripped; results are lowercased.
   */
  extractHeaderHosts(value) {
    const hosts = [];
    const urlRe = /https?:\/\/([^/>\s,]+)/gi;
    let m;
    while ((m = urlRe.exec(value)) !== null) {
      hosts.push(m[1].toLowerCase().replace(/:\d+$/, ""));
    }
    const mailRe = /mailto:[^@>\s]+@([^>\s,?]+)/gi;
    while ((m = mailRe.exec(value)) !== null) {
      hosts.push(m[1].toLowerCase());
    }
    return hosts;
  }
  addSpamDomain(domain) {
    this.customSpamDomains.add(domain.toLowerCase());
  }
  removeSpamDomain(domain) {
    this.customSpamDomains.delete(domain.toLowerCase());
  }
  addWhitelistDomain(domain) {
    this.customWhitelistDomains.add(domain.toLowerCase());
  }
  removeWhitelistDomain(domain) {
    this.customWhitelistDomains.delete(domain.toLowerCase());
  }
  getKnownSpamDomains() {
    return [...KNOWN_SPAM_DOMAINS, ...this.customSpamDomains];
  }
  getWhitelistDomains() {
    return [...this.customWhitelistDomains];
  }
  // Check domain against IPQualityScore API (if configured)
  async checkDomainReputation(domain) {
    const apiKey = process.env.IPQUALITYSCORE_API_KEY;
    if (!apiKey) {
      return { error: "IPQualityScore API key not configured" };
    }
    try {
      const response = await fetch(
        `https://www.ipqualityscore.com/api/json/email/${apiKey}/${encodeURIComponent(`test@${domain}`)}`
      );
      if (!response.ok) {
        return { error: `API request failed: ${response.status}` };
      }
      const data = await response.json();
      return {
        score: data.fraud_score,
        suspicious: data.suspicious,
        disposable: data.disposable
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "API request failed" };
    }
  }
};

// src/tools/account-tools.ts
import { z } from "zod";
function accountTools(server2, accountManager2, imapService2, smtpService2) {
  server2.registerTool("imap_add_account", {
    description: "Add a new IMAP account configuration",
    inputSchema: {
      name: z.string().describe("Friendly name for the account"),
      host: z.string().describe("IMAP server hostname"),
      port: z.coerce.number().default(993).describe("IMAP server port (default: 993)"),
      user: z.string().describe("Username for authentication"),
      password: z.string().describe("Password for authentication"),
      tls: z.boolean().default(true).describe("Use TLS/SSL (default: true)"),
      email: z.string().optional().describe("Email address (From: header). Defaults to user if omitted"),
      smtpHost: z.string().optional().describe("SMTP server hostname. Defaults to IMAP host with imap.\u2192smtp. rewrite"),
      smtpPort: z.coerce.number().optional().describe("SMTP server port (465 for SMTPS, 587 for STARTTLS). Defaults to 587"),
      smtpSecure: z.boolean().optional().describe("Use implicit TLS (SMTPS). Ignored for port 587/25 which always use STARTTLS, and for port 465 which always uses implicit TLS"),
      sentFolder: z.string().optional().describe('Explicit Sent-folder name for saving sent-mail copies (e.g. "Gesendet"). Only needed when auto-detection fails \u2014 the server must lack a \\Sent SPECIAL-USE folder. Check names with imap_list_folders'),
      defaultBcc: z.union([z.string(), z.array(z.string())]).optional().describe("Optional BCC address(es) applied automatically to every outbound send, reply, forward, and draft for this account. Merged with any per-call bcc")
    }
  }, async ({ name, host, port, user, password, tls, email, smtpHost, smtpPort, smtpSecure, sentFolder, defaultBcc }) => {
    const smtp = smtpHost || smtpPort !== void 0 || smtpSecure !== void 0 ? {
      host: smtpHost || host,
      port: smtpPort ?? 587,
      secure: smtpSecure ?? false
    } : void 0;
    const account = await accountManager2.addAccount({
      name,
      host,
      port,
      user,
      password,
      tls,
      ...email ? { email } : {},
      ...smtp ? { smtp } : {},
      ...sentFolder ? { sentFolder } : {},
      ...defaultBcc !== void 0 && defaultBcc !== "" && !(Array.isArray(defaultBcc) && defaultBcc.length === 0) ? { defaultBcc } : {}
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          accountId: account.id,
          message: `Account "${name}" added successfully`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_update_account", {
    description: "Update an existing IMAP account. Useful for fixing SMTP settings without removing and re-adding the account.",
    inputSchema: {
      accountId: z.string().describe("ID of the account to update"),
      name: z.string().optional().describe("New friendly name"),
      host: z.string().optional().describe("IMAP host"),
      port: z.coerce.number().optional().describe("IMAP port"),
      user: z.string().optional().describe("IMAP username"),
      password: z.string().optional().describe("New password"),
      tls: z.boolean().optional().describe("Use TLS for IMAP"),
      email: z.string().optional().describe("Email address (From: header)"),
      smtpHost: z.string().optional().describe("SMTP hostname"),
      smtpPort: z.coerce.number().optional().describe("SMTP port (465 for SMTPS, 587 for STARTTLS)"),
      smtpSecure: z.boolean().optional().describe("Use implicit TLS (SMTPS). Port 587/25 always use STARTTLS regardless"),
      smtpUser: z.string().optional().describe("SMTP username (if different from IMAP user)"),
      smtpPassword: z.string().optional().describe("SMTP password (if different from IMAP password)"),
      saveToSent: z.boolean().optional().describe("Save sent emails to the Sent folder"),
      sentFolder: z.string().optional().describe('Explicit Sent-folder name for saving sent-mail copies (e.g. "Gesendet"). Overrides auto-detection; pass an empty string to clear the override and re-enable auto-detection. Check names with imap_list_folders'),
      defaultBcc: z.union([z.string(), z.array(z.string())]).optional().describe("Optional BCC address(es) applied automatically to every outbound message for this account. Pass an empty string to clear")
    }
  }, async ({ accountId, name, host, port, user, password, tls, email, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, saveToSent, sentFolder, defaultBcc }) => {
    const existing = accountManager2.getAccount(accountId);
    if (!existing) {
      throw new Error(`Account ${accountId} not found`);
    }
    const updates = {};
    if (name !== void 0) updates.name = name;
    if (host !== void 0) updates.host = host;
    if (port !== void 0) updates.port = port;
    if (user !== void 0) updates.user = user;
    if (password !== void 0) updates.password = password;
    if (tls !== void 0) updates.tls = tls;
    if (email !== void 0) updates.email = email;
    if (saveToSent !== void 0) updates.saveToSent = saveToSent;
    if (sentFolder !== void 0) updates.sentFolder = sentFolder === "" ? void 0 : sentFolder;
    if (defaultBcc !== void 0) {
      if (defaultBcc === "" || Array.isArray(defaultBcc) && defaultBcc.length === 0) {
        updates.defaultBcc = void 0;
      } else {
        updates.defaultBcc = defaultBcc;
      }
    }
    const smtpTouched = [smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword].some((v) => v !== void 0);
    if (smtpTouched) {
      const current = existing.smtp;
      updates.smtp = {
        host: smtpHost ?? current?.host ?? existing.host,
        port: smtpPort ?? current?.port ?? 587,
        secure: smtpSecure ?? current?.secure ?? false,
        ...smtpUser !== void 0 ? { user: smtpUser } : current?.user ? { user: current.user } : {},
        ...smtpPassword !== void 0 ? { password: smtpPassword } : {}
      };
    }
    if (smtpTouched) {
      smtpService2.disconnect(accountId);
    }
    const updated = await accountManager2.updateAccount(accountId, updates);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          accountId: updated.id,
          message: `Account "${updated.name}" updated`,
          smtp: updated.smtp ? { host: updated.smtp.host, port: updated.smtp.port, secure: updated.smtp.secure } : void 0
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_list_accounts", {
    description: "List all configured IMAP accounts",
    inputSchema: {}
  }, async () => {
    const accounts = accountManager2.getAllAccounts();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          accounts: accounts.map((acc) => ({
            id: acc.id,
            name: acc.name,
            host: acc.host,
            port: acc.port,
            user: acc.user,
            tls: acc.tls
          }))
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_remove_account", {
    description: "Remove an IMAP account configuration",
    inputSchema: {
      accountId: z.string().describe("ID of the account to remove")
    }
  }, async ({ accountId }) => {
    await imapService2.disconnect(accountId);
    await accountManager2.removeAccount(accountId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Account ${accountId} removed successfully`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_connect", {
    description: "Connect to an IMAP account",
    inputSchema: {
      accountId: z.string().optional().describe("Account ID to connect to"),
      accountName: z.string().optional().describe("Account name to connect to")
    }
  }, async ({ accountId, accountName }) => {
    let account;
    if (accountId) {
      account = accountManager2.getAccount(accountId);
    } else if (accountName) {
      account = accountManager2.getAccountByName(accountName);
    } else {
      throw new Error("Either accountId or accountName must be provided");
    }
    if (!account) {
      throw new Error("Account not found");
    }
    await imapService2.connect(account);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Connected to account "${account.name}"`,
          accountId: account.id
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_disconnect", {
    description: "Disconnect from an IMAP account",
    inputSchema: {
      accountId: z.string().describe("Account ID to disconnect from")
    }
  }, async ({ accountId }) => {
    await imapService2.disconnect(accountId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Disconnected from account ${accountId}`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_test_account", {
    description: "Test an existing account connection without re-entering credentials. Validates IMAP connectivity and returns folder count and message count.",
    inputSchema: {
      accountId: z.string().describe("Account ID to test")
    }
  }, async ({ accountId }) => {
    const account = accountManager2.getAccount(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }
    const result = await imapService2.testConnection(account);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          accountId,
          accountName: account.name,
          host: account.host,
          ...result
        }, null, 2)
      }]
    };
  });
}

// src/utils/search-folders.ts
var TRASH_FOLDER_NAMES = ["trash", "bin", "deleted", "deleted items", "deleted messages"];
var SPAM_FOLDER_NAMES = ["spam", "junk", "junk email", "junk e-mail", "bulk mail"];
var DRAFTS_FOLDER_NAMES = ["drafts", "draft"];
var BLOCKED_FOLDER_NAMES = ["blocked"];
function leafName(folder) {
  const delimiter = folder.delimiter || "/";
  const parts = folder.name.split(delimiter);
  return parts[parts.length - 1] || folder.name;
}
function isNonSelectable(folder) {
  return (folder.attributes || []).some((a) => a.toLowerCase() === "\\noselect");
}
function matchesCategory(folder, specialUse, names) {
  if (folder.specialUse && folder.specialUse.toLowerCase() === specialUse.toLowerCase()) {
    return true;
  }
  const full = folder.name.toLowerCase();
  const leaf = leafName(folder).toLowerCase();
  return names.includes(full) || names.includes(leaf);
}
function selectSearchFolders(folders, opts = {}) {
  const { includeTrash = false, includeSpam = false, includeDrafts = false } = opts;
  return folders.filter((folder) => !isNonSelectable(folder)).filter((folder) => {
    const full = folder.name.toLowerCase();
    const leaf = leafName(folder).toLowerCase();
    if (BLOCKED_FOLDER_NAMES.includes(full) || BLOCKED_FOLDER_NAMES.includes(leaf)) return false;
    if (!includeTrash && matchesCategory(folder, "\\Trash", TRASH_FOLDER_NAMES)) return false;
    if (!includeSpam && matchesCategory(folder, "\\Junk", SPAM_FOLDER_NAMES)) return false;
    if (!includeDrafts && matchesCategory(folder, "\\Drafts", DRAFTS_FOLDER_NAMES)) return false;
    return true;
  }).map((folder) => folder.name);
}

// src/utils/default-bcc.ts
function mergeBcc(defaultBcc, explicitBcc) {
  const normalize = (value) => {
    if (value === void 0 || value === null) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => entry.trim()).filter(Boolean);
  };
  const bareAddress = (addr) => {
    const match = addr.match(/<([^>]+)>/);
    return (match ? match[1] : addr).trim().toLowerCase();
  };
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  for (const addr of [...normalize(explicitBcc), ...normalize(defaultBcc)]) {
    const key = bareAddress(addr);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(addr);
  }
  if (merged.length === 0) return void 0;
  if (merged.length === 1) return merged[0];
  return merged;
}

// src/tools/email-tools.ts
import { z as z2 } from "zod";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
var accountSelector = {
  accountId: z2.string().optional().describe("Account ID (from imap_list_accounts). Optional if accountName is given or only one account is configured."),
  accountName: z2.string().optional().describe("Account name instead of accountId. Optional if accountId is given or only one account is configured.")
};
var addressList = (field, description) => z2.preprocess(
  (value) => parseSerializedArray(value, field),
  z2.union([z2.string(), z2.array(z2.string())])
).describe(description);
var uidList = (description) => z2.preprocess(
  (value) => parseSerializedArray(value, "uid"),
  z2.union([z2.coerce.number(), z2.array(z2.coerce.number())])
).describe(description);
var buildAttachments = (atts) => atts?.map((att) => ({
  filename: att.filename,
  content: att.content ? Buffer.from(att.content, "base64") : void 0,
  path: att.path,
  contentType: att.contentType,
  contentDisposition: att.contentDisposition,
  cid: att.cid
}));
var resolveBcc = (account, explicitBcc) => mergeBcc(account.defaultBcc, explicitBcc);
var attachmentSchema = z2.object({
  filename: z2.string().describe("Attachment filename"),
  content: z2.string().optional().describe("Base64 encoded content"),
  path: z2.string().optional().describe("File path to attach"),
  contentType: z2.string().optional().describe("MIME type"),
  contentDisposition: z2.enum(["attachment", "inline"]).optional().describe(
    'How the attachment is presented. Use "inline" for images referenced from the HTML body via cid: (e.g. a signature/footer banner); omit or use "attachment" for regular downloadable files.'
  ),
  cid: z2.string().optional().describe(
    'Content-ID for inline attachments. Required when contentDisposition is "inline" and the HTML references the image as <img src="cid:THIS_VALUE">. Must match exactly (without the "cid:" prefix or angle brackets).'
  )
});
var bccSchema = addressList(
  "bcc",
  "BCC recipients. Either an array of addresses or a single comma-separated string; merged with the account defaultBcc when set."
).optional();
async function saveSentCopy(imapService2, accountId, account, rawMessage) {
  if (!rawMessage || account.saveToSent === false) {
    return { attempted: false, saved: false };
  }
  try {
    const result = await imapService2.appendToSentFolder(accountId, rawMessage, account.sentFolder);
    return { attempted: true, ...result };
  } catch (err) {
    return { attempted: true, saved: false, error: err instanceof Error ? err.message : String(err) };
  }
}
var sentSaveFields = (outcome) => ({
  savedToSent: outcome.saved,
  ...outcome.folder ? { sentFolder: outcome.folder } : {},
  ...outcome.attempted && !outcome.saved ? { sentSaveError: outcome.error ?? "Unknown error" } : {}
});
var sentSaveSuffix = (outcome) => {
  if (outcome.saved) return ` (saved to "${outcome.folder}")`;
  if (outcome.attempted) return " (warning: copy NOT saved to Sent folder \u2014 see sentSaveError)";
  return "";
};
var DOWNLOAD_DIR = process.env.IMAP_DOWNLOAD_DIR || join(homedir(), "Downloads", "imap-attachments");
var MAX_UPLOAD_SIZE = parseInt(process.env.IMAP_MAX_UPLOAD_SIZE ?? "", 10) || 25 * 1024 * 1024;
var UPLOAD_TTL_MS = parseInt(process.env.IMAP_UPLOAD_TTL_MS ?? "", 10) || 24 * 60 * 60 * 1e3;
function emailTools(server2, imapService2, accountManager2, smtpService2) {
  const parseDateOnly = (value) => {
    const parts = value.split("-").map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
      return new Date(value);
    }
    const [year, month, day] = parts;
    return new Date(year, month - 1, day);
  };
  server2.registerTool("imap_search_emails", {
    description: `Note: on some servers a 'flagged' or starred message carries a custom keyword (e.g. an Open-Xchange color label or Apple's $MailFlagBit*) instead of, or in addition to, the \\Flagged system flag. After any flagged search, inspect each result's customKeywords field before concluding a message is or isn't flagged \u2014 do not rely on the flagged filter alone. Search for emails matching criteria (sender, recipient, subject, body text, date range, read/flagged status). Use this to FIND messages when you know something about them but not their UID \u2014 e.g. "emails from amazon last week", "unread invoices". By default searches a single folder (INBOX). Set searchAllFolders=true to scan every mailbox at once \u2014 this catches messages filed away by rules (e.g. a receipt routed to a custom folder); Trash/Spam/Drafts are skipped unless you opt in. By default returns lightweight headers (uid, from, subject, date, and folder when searching across folders); set \`includeBody=true\` to also return the parsed body in one round-trip instead of paying the N+1 cost of calling imap_get_email per match. For the newest messages without criteria, prefer imap_get_latest_emails.`,
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name to search (default: INBOX). Ignored when searchAllFolders is true."),
      searchAllFolders: z2.boolean().default(false).describe("Search across ALL folders instead of just `folder`. Skips Trash/Spam/Drafts and non-selectable folders by default. Use when a message might have been filed/archived/moved and you do not know which folder it is in."),
      includeTrash: z2.boolean().default(false).describe("When searchAllFolders is true, also search Trash/Bin/Deleted folders (off by default \u2014 noisy)."),
      includeSpam: z2.boolean().default(false).describe("When searchAllFolders is true, also search Spam/Junk folders (off by default \u2014 noisy)."),
      includeDrafts: z2.boolean().default(false).describe("When searchAllFolders is true, also search the Drafts folder (off by default)."),
      from: z2.string().optional().describe("Search by sender"),
      to: z2.string().optional().describe("Search by recipient"),
      subject: z2.string().optional().describe("Search by subject"),
      body: z2.string().optional().describe("Search in body text"),
      since: z2.string().optional().describe("Search emails since date (YYYY-MM-DD)"),
      before: z2.string().optional().describe("Search emails before date (YYYY-MM-DD)"),
      seen: z2.boolean().optional().describe("Filter by read/unread status"),
      flagged: z2.boolean().optional().describe("Filter by flagged status"),
      messageId: z2.string().optional().describe("Search by RFC822 Message-ID header (substring match)"),
      keywords: z2.array(z2.string()).optional().describe("Match messages that have ANY of these CUSTOM keywords (server-side OR; not system flags like \\Seen/\\Flagged). Read a mailbox's available custom keywords from imap_folder_status's customKeywords field, then pass the ones you want here."),
      unKeywords: z2.array(z2.string()).optional().describe("Exclude messages that have ANY of these CUSTOM keywords (server-side; result has NONE of them). Same keyword source as `keywords` \u2014 check imap_folder_status first."),
      limit: z2.coerce.number().optional().default(50).describe("Maximum number of results"),
      includeBody: z2.boolean().default(false).describe("If true, also fetch the parsed message body in the same round-trip and return it alongside headers (avoids the N+1 cost of calling imap_get_email per match). Body is rendered per `bodyFormat` and capped at `bodyMaxLength` characters per field. Off by default to preserve lightweight behavior."),
      bodyFormat: z2.enum(["markdown", "text", "html", "auto"]).default("markdown").describe('How to render the body when `includeBody` is true. Mirrors `imap_get_email` \u2014 "markdown" (default) returns clean Markdown and omits raw HTML so it never crosses the MCP boundary; "text" returns plain text; "html" returns raw HTML; "auto" prefers substantive text/plain, else Markdown.'),
      bodyMaxLength: z2.coerce.number().default(1e4).describe("Per-message cap (in characters) for each rendered body field when `includeBody` is true. Defaults to 10000 to match `imap_get_email`.")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, limit, searchAllFolders, includeTrash, includeSpam, includeDrafts, includeBody = false, bodyFormat = "markdown", bodyMaxLength = 1e4, ...searchCriteria }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const criteria = {};
    if (searchCriteria.from) criteria.from = searchCriteria.from;
    if (searchCriteria.to) criteria.to = searchCriteria.to;
    if (searchCriteria.subject) criteria.subject = searchCriteria.subject;
    if (searchCriteria.body) criteria.body = searchCriteria.body;
    if (searchCriteria.since) criteria.since = parseDateOnly(searchCriteria.since);
    if (searchCriteria.before) criteria.before = parseDateOnly(searchCriteria.before);
    if (searchCriteria.seen !== void 0) criteria.seen = searchCriteria.seen;
    if (searchCriteria.flagged !== void 0) criteria.flagged = searchCriteria.flagged;
    if (searchCriteria.messageId) criteria.messageId = searchCriteria.messageId;
    if (searchCriteria.keywords && searchCriteria.keywords.length > 0) criteria.keywords = searchCriteria.keywords;
    if (searchCriteria.unKeywords && searchCriteria.unKeywords.length > 0) criteria.unKeywords = searchCriteria.unKeywords;
    const searchOptions = searchAllFolders ? void 0 : { includeBody, bodyFormat, bodyMaxLength };
    if (searchAllFolders) {
      const allFolders = await imapService2.listFolders(accountId);
      const targets = selectSearchFolders(allFolders, { includeTrash, includeSpam, includeDrafts });
      const collected = [];
      const foldersSearched = [];
      const foldersErrored = [];
      for (const folderName of targets) {
        try {
          const part = await imapService2.searchEmails(accountId, folderName, criteria);
          foldersSearched.push(folderName);
          for (const message of part) {
            collected.push({ ...message, folder: folderName });
          }
        } catch (err) {
          foldersErrored.push({
            folder: folderName,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 200)
          });
        }
      }
      collected.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const limitedMessages2 = collected.slice(0, limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalFound: collected.length,
            returned: limitedMessages2.length,
            foldersSearched,
            ...foldersErrored.length > 0 ? { foldersErrored } : {},
            messages: limitedMessages2
          }, null, 2)
        }]
      };
    }
    const messages = await imapService2.searchEmails(accountId, folder, criteria, searchOptions);
    const sortedMessages = messages.sort((a, b) => b.date.getTime() - a.date.getTime());
    const limitedMessages = sortedMessages.slice(0, limit);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          totalFound: messages.length,
          returned: limitedMessages.length,
          messages: limitedMessages
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_get_email", {
    description: 'Read the FULL content of a single email by its UID (body, sender/recipients, date, attachment list, optional raw headers and text-attachment previews). By default the body is returned as clean Markdown in markdownContent and raw HTML is omitted so it never crosses the boundary; set bodyFormat to "html" for the legacy raw htmlContent, or "text" for plain text only. Use after imap_search_emails or imap_get_latest_emails gives you a uid. Body text is truncated to maxContentLength to protect the context window \u2014 raise it for long messages. To fetch attachment bytes, use imap_download_attachment.',
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: z2.coerce.number().describe("Email UID"),
      maxContentLength: z2.coerce.number().default(1e4).describe("Maximum characters to return for each body field (text/markdown/html)"),
      bodyFormat: z2.enum(["markdown", "text", "html", "auto"]).default("markdown").describe('How to return the body. "markdown" (default): clean Markdown via Turndown in markdownContent, raw htmlContent omitted so HTML never crosses the boundary. "text": plain text only in textContent. "html": legacy raw htmlContent. "auto": substantive text/plain if available, else Markdown.'),
      includeAttachmentText: z2.boolean().default(true).describe("Include text attachment previews when available"),
      maxAttachmentTextChars: z2.coerce.number().default(1e5).describe("Maximum characters to return per text attachment"),
      includeHeaders: z2.boolean().default(false).describe("Include raw email headers (e.g. List-Unsubscribe, List-Unsubscribe-Post)")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid, maxContentLength, bodyFormat, includeAttachmentText, maxAttachmentTextChars, includeHeaders }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const email = await imapService2.getEmailContent(accountId, folder, uid, {
      includeAttachmentText,
      maxAttachmentTextChars,
      bodyFormat
    });
    const cap = (s) => s === void 0 ? void 0 : s.substring(0, maxContentLength);
    const textTruncated = email.textContent ? email.textContent.length > maxContentLength : false;
    const htmlTruncated = email.htmlContent ? email.htmlContent.length > maxContentLength : false;
    const markdownTruncated = email.markdownContent ? email.markdownContent.length > maxContentLength : false;
    const contentTruncated = textTruncated || htmlTruncated || markdownTruncated ? { text: textTruncated || void 0, html: htmlTruncated || void 0, markdown: markdownTruncated || void 0 } : void 0;
    const { headers: rawHeaders, ...emailWithoutHeaders } = email;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          email: {
            ...emailWithoutHeaders,
            textContent: cap(email.textContent),
            htmlContent: cap(email.htmlContent),
            markdownContent: cap(email.markdownContent),
            contentTruncated,
            ...includeHeaders ? { headers: rawHeaders } : {}
          }
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_upload_file", {
    description: `Upload a file to the server for use as an email attachment. Returns a path that can be used with imap_send_email attachments. This allows sending large attachments without hitting context window limits. Max size: ${MAX_UPLOAD_SIZE} bytes (configurable via IMAP_MAX_UPLOAD_SIZE). Uploads are auto-deleted after ${UPLOAD_TTL_MS} ms (configurable via IMAP_UPLOAD_TTL_MS).`,
    inputSchema: {
      filename: z2.string().describe("Filename to save as"),
      content: z2.string().describe("Base64 encoded file content"),
      contentType: z2.string().optional().describe("MIME type (optional, used for metadata only)")
    }
  }, async ({ filename, content, contentType }) => {
    const fs2 = await import("fs");
    const path2 = await import("path");
    const uploadDir = path2.join(DOWNLOAD_DIR, "uploads");
    fs2.mkdirSync(uploadDir, { recursive: true });
    const now = Date.now();
    try {
      for (const entry of fs2.readdirSync(uploadDir)) {
        const entryPath = path2.join(uploadDir, entry);
        try {
          const stat = fs2.statSync(entryPath);
          if (stat.isFile() && now - stat.mtimeMs > UPLOAD_TTL_MS) {
            fs2.unlinkSync(entryPath);
          }
        } catch {
        }
      }
    } catch {
    }
    const buffer = Buffer.from(content, "base64");
    if (buffer.length > MAX_UPLOAD_SIZE) {
      throw new Error(`File exceeds max upload size of ${MAX_UPLOAD_SIZE} bytes (got ${buffer.length}). Increase IMAP_MAX_UPLOAD_SIZE if needed.`);
    }
    const sanitizedFilename = path2.basename(filename);
    const uniquePrefix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const targetPath = path2.join(uploadDir, `${uniquePrefix}-${sanitizedFilename}`);
    fs2.writeFileSync(targetPath, buffer);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          path: targetPath,
          filename: sanitizedFilename,
          size: buffer.length,
          contentType: contentType || "application/octet-stream",
          expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),
          message: `File uploaded successfully. Use this path in imap_send_email attachments: ${targetPath}`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_download_attachment", {
    description: "Download a single attachment from an email (folder + uid + attachment filename/contentId, as listed by imap_get_email). Images are returned inline for viewing; PDFs are saved and their text is extracted inline (extractText); other files are saved to the shared downloads directory (or savePath). Use when the user wants the actual file contents, not just the message body.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: z2.coerce.number().describe("Email UID"),
      filename: z2.string().describe("Attachment filename or contentId"),
      savePath: z2.string().optional().describe("Optional file path to save the attachment to. If not provided, files are saved to the shared downloads directory."),
      extractText: z2.boolean().default(true).describe("For PDFs, extract and return text content inline")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid, filename, savePath, extractText }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const { content, contentType, filename: resolvedFilename } = await imapService2.getAttachmentContent(accountId, folder, uid, filename);
    const isImage = contentType.startsWith("image/");
    const isPdf = contentType === "application/pdf" || resolvedFilename.toLowerCase().endsWith(".pdf");
    if (isImage && !savePath) {
      return {
        content: [
          {
            type: "text",
            text: `Attachment: ${resolvedFilename} (${contentType}, ${content.length} bytes)`
          },
          {
            type: "image",
            data: content.toString("base64"),
            mimeType: contentType
          }
        ]
      };
    }
    if (isPdf && extractText) {
      try {
        const { PDFParse } = await import("pdf-parse");
        const pdfParser = new PDFParse({ data: content });
        let pdfText;
        let pdfPages;
        try {
          const pdfData = await pdfParser.getText({ pageJoiner: "" });
          pdfText = pdfData.text;
          pdfPages = pdfData.total;
        } finally {
          await pdfParser.destroy();
        }
        const fs3 = await import("fs");
        const path3 = await import("path");
        const downloadDir2 = savePath ? path3.dirname(savePath) : DOWNLOAD_DIR;
        fs3.mkdirSync(downloadDir2, { recursive: true });
        const targetPath2 = savePath || path3.join(DOWNLOAD_DIR, path3.basename(resolvedFilename));
        fs3.writeFileSync(targetPath2, content);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              saved: true,
              path: targetPath2,
              filename: resolvedFilename,
              contentType,
              size: content.length,
              pages: pdfPages,
              textContent: pdfText
            }, null, 2)
          }]
        };
      } catch (err) {
        console.error("PDF text extraction failed:", err);
      }
    }
    const fs2 = await import("fs");
    const path2 = await import("path");
    const downloadDir = savePath ? path2.dirname(savePath) : DOWNLOAD_DIR;
    fs2.mkdirSync(downloadDir, { recursive: true });
    const targetPath = savePath || path2.join(DOWNLOAD_DIR, path2.basename(resolvedFilename));
    fs2.writeFileSync(targetPath, content);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          saved: true,
          path: targetPath,
          filename: resolvedFilename,
          contentType,
          size: content.length
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_mark_as_read", {
    description: "Mark one or many emails as read. Accepts a single UID or an array \u2014 pass an array to flag N messages in one IMAP STORE round-trip (useful when triaging).",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: uidList("Email UID, or array of UIDs to mark as read in one call (avoids N round-trips when triaging). All listed UIDs share the same IMAP STORE command, so the operation is atomic at the server level.").nonoptional()
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const result = await imapService2.markAsRead(accountId, folder, uid);
    const isBatch = Array.isArray(uid);
    if (!isBatch) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Email ${uid} marked as read`
          }, null, 2)
        }]
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: result.failed.length === 0,
          batch: true,
          message: `Marked ${result.marked.length}/${uid.length} emails as read`,
          marked: result.marked,
          failed: result.failed,
          ...result.errors ? { errors: result.errors } : {}
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_mark_as_unread", {
    description: "Mark one or many emails as unread. Accepts a single UID or an array \u2014 pass an array to flag N messages in one IMAP STORE round-trip.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: uidList("Email UID, or array of UIDs to mark as unread in one call (avoids N round-trips when triaging). All listed UIDs share the same IMAP STORE command, so the operation is atomic at the server level.").nonoptional()
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const result = await imapService2.markAsUnread(accountId, folder, uid);
    const isBatch = Array.isArray(uid);
    if (!isBatch) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Email ${uid} marked as unread`
          }, null, 2)
        }]
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: result.failed.length === 0,
          batch: true,
          message: `Marked ${result.marked.length}/${uid.length} emails as unread`,
          marked: result.marked,
          failed: result.failed,
          ...result.errors ? { errors: result.errors } : {}
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_flag_email", {
    description: "Flag an email \u2014 sets the IMAP \\Flagged system flag (shows as a star in Gmail / a flag in Apple Mail). Use this tool when a user asks to star, flag, or mark a message as important.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: z2.coerce.number().describe("Email UID")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    await imapService2.flagEmail(accountId, folder, uid);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Email ${uid} flagged`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_unflag_email", {
    description: "Unflag an email \u2014 removes the IMAP \\Flagged system flag (the star in Gmail, the flag in Apple Mail). Note: some servers (e.g. Open-Xchange / Network Solutions) and Apple Mail also write a separate custom keyword such as $cl_N or $MailFlagBit* when a message is flagged in their client. Removing \\Flagged alone does not clear that keyword, so the message may still display as flagged. If it does, check the message's customKeywords via imap_get_email and remove the lingering label with imap_remove_keyword.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: z2.coerce.number().describe("Email UID")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    await imapService2.unflagEmail(accountId, folder, uid);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Email ${uid} unflagged`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_add_keyword", {
    description: "Set an arbitrary custom (non-system) IMAP keyword/label on an email \u2014 e.g. a provider color label like Open-Xchange's $cl_1..$cl_10, Apple Mail's $MailFlagBit0..$MailFlagBit2, or an app tag such as $promotion. Unlike imap_flag_email (which only ever sets the system \\Flagged flag), this passes the keyword through verbatim, but rejects backslash-prefixed system flags (e.g. \\Flagged, \\Seen, \\Deleted) \u2014 use the dedicated flag/read tools for those. Not every IMAP server permits custom keywords (see the mailbox's PERMANENTFLAGS) \u2014 if the server rejects or silently ignores the change, this call fails rather than reporting success.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: z2.coerce.number().describe("Email UID"),
      keyword: z2.string().describe('IMAP keyword to set, passed through verbatim (e.g. "$cl_3", "$MailFlagBit0", "$Junk")')
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid, keyword }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    await imapService2.addKeyword(accountId, folder, uid, keyword);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Keyword "${keyword}" added to email ${uid}`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_remove_keyword", {
    description: "Remove an arbitrary custom (non-system) IMAP keyword/label from an email \u2014 e.g. a provider color label like Open-Xchange's $cl_1..$cl_10, Apple Mail's $MailFlagBit0..$MailFlagBit2, or an app tag such as $promotion. Unlike imap_unflag_email (which only ever clears the system \\Flagged flag), this passes the keyword through verbatim, but rejects backslash-prefixed system flags (e.g. \\Flagged, \\Seen, \\Deleted) \u2014 use the dedicated flag/read tools for those. Not every IMAP server permits custom keywords (see the mailbox's PERMANENTFLAGS) \u2014 if the server rejects or silently ignores the change, this call fails rather than reporting success.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: z2.coerce.number().describe("Email UID"),
      keyword: z2.string().describe('IMAP keyword to remove, passed through verbatim (e.g. "$cl_3", "$MailFlagBit0", "$Junk")')
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid, keyword }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    await imapService2.removeKeyword(accountId, folder, uid, keyword);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Keyword "${keyword}" removed from email ${uid}`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_delete_email", {
    description: "Delete ONE email by folder + uid (moves to Trash or expunges, server-dependent). Destructive and not easily undone \u2014 confirm the user means this specific message. To remove many at once use imap_bulk_delete (known uids) or imap_bulk_delete_by_search (by criteria, supports dryRun). To file an email away instead of deleting, use imap_move_email.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uid: z2.coerce.number().describe("Email UID")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    await imapService2.deleteEmail(accountId, folder, uid);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Email ${uid} deleted`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_move_email", {
    description: "Move an email from one folder to another (e.g., INBOX to Taxes, or INBOX to Archive). Optionally creates the destination folder if it does not exist.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Source folder name"),
      uid: uidList('Single email UID or array of UIDs to move in one call. Pass an array when triaging many messages at once (e.g. "move the 10 invoices I just classified to Archive") to avoid N round-trips.'),
      targetFolder: z2.string().describe("Destination folder name"),
      createDestinationIfMissing: z2.boolean().optional().describe("If true, create the destination folder before moving when it does not exist (default: false)")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid, targetFolder, createDestinationIfMissing }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const isBatch = Array.isArray(uid);
    try {
      const result = await imapService2.moveEmail(accountId, folder, uid, targetFolder, {
        createDestinationIfMissing
      });
      if (!isBatch) {
        const single = result;
        const uidMapObj = {};
        if (single.uidMap) {
          for (const [srcUid, destUid] of single.uidMap) {
            uidMapObj[String(srcUid)] = destUid;
          }
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Email ${uid} moved from ${folder} to ${targetFolder}`,
              destination: single.destination,
              destinationCreated: single.destinationCreated,
              uidMap: Object.keys(uidMapObj).length > 0 ? uidMapObj : void 0
            }, null, 2)
          }]
        };
      }
      const batch = result;
      const succeeded = batch.results.filter((r) => !r.error);
      const failed = batch.results.filter((r) => r.error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: failed.length === 0,
            batch: true,
            message: `Moved ${succeeded.length}/${batch.results.length} emails from ${folder} to ${targetFolder}`,
            destination: batch.destination,
            destinationCreated: batch.destinationCreated,
            movedCount: succeeded.length,
            failedCount: failed.length,
            results: batch.results,
            ...failed.length > 0 ? { errors: failed.map((f) => ({ uid: f.uid, error: f.error })) } : {}
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            message: `Failed to move email ${uid} from ${folder} to ${targetFolder}`,
            error: err instanceof Error ? err.message : "Unknown error"
          }, null, 2)
        }]
      };
    }
  });
  server2.registerTool("imap_bulk_delete", {
    description: "Delete multiple emails at once with chunking and auto-reconnection. Processes deletions in batches to prevent connection timeouts.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      uids: z2.array(z2.coerce.number()).describe("Array of email UIDs to delete"),
      chunkSize: z2.coerce.number().default(50).describe("Number of emails to delete per batch (default: 50)")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uids, chunkSize }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const result = await imapService2.bulkDelete(accountId, folder, uids, chunkSize);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: result.failed === 0,
          totalRequested: uids.length,
          deleted: result.deleted,
          failed: result.failed,
          errors: result.errors.length > 0 ? result.errors : void 0,
          message: result.failed === 0 ? `Successfully deleted ${result.deleted} emails` : `Deleted ${result.deleted} emails, ${result.failed} failed`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_bulk_delete_by_search", {
    description: "Search for emails matching criteria and delete them all. Useful for cleaning up spam or unwanted emails. At least one concrete criterion (from, to, subject, before, or since) is REQUIRED \u2014 a call with no criteria is refused so it can never wipe an entire folder. Supports dryRun to preview matches first.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      from: z2.string().optional().describe("Delete emails from this sender"),
      to: z2.string().optional().describe("Delete emails to this recipient"),
      subject: z2.string().optional().describe("Delete emails with this subject"),
      before: z2.string().optional().describe("Delete emails before this date (YYYY-MM-DD)"),
      since: z2.string().optional().describe("Delete emails since this date (YYYY-MM-DD)"),
      chunkSize: z2.coerce.number().default(50).describe("Number of emails to delete per batch"),
      dryRun: z2.boolean().default(false).describe("If true, only return what would be deleted without actually deleting")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, from, to, subject, before, since, chunkSize, dryRun }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const criteria = {};
    if (from) criteria.from = from;
    if (to) criteria.to = to;
    if (subject) criteria.subject = subject;
    if (before) criteria.before = parseDateOnly(before);
    if (since) criteria.since = parseDateOnly(since);
    if (Object.keys(criteria).length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            found: 0,
            deleted: 0,
            error: "Refusing to bulk-delete without criteria. Specify at least one of from, to, subject, before, or since \u2014 an empty criteria set would match and delete the entire folder."
          }, null, 2)
        }]
      };
    }
    const messages = await imapService2.searchEmails(accountId, folder, criteria);
    if (messages.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            found: 0,
            deleted: 0,
            message: "No emails matched the search criteria"
          }, null, 2)
        }]
      };
    }
    if (dryRun) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            dryRun: true,
            found: messages.length,
            wouldDelete: messages.length,
            samples: messages.slice(0, 10).map((m) => ({
              uid: m.uid,
              from: m.from,
              subject: m.subject,
              date: m.date
            })),
            message: `Would delete ${messages.length} emails (dry run)`
          }, null, 2)
        }]
      };
    }
    const uids = messages.map((m) => m.uid);
    const result = await imapService2.bulkDelete(accountId, folder, uids, chunkSize);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: result.failed === 0,
          found: messages.length,
          deleted: result.deleted,
          failed: result.failed,
          errors: result.errors.length > 0 ? result.errors : void 0,
          message: result.failed === 0 ? `Successfully deleted ${result.deleted} emails matching criteria` : `Deleted ${result.deleted} emails, ${result.failed} failed`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_get_latest_emails", {
    description: 'Get the most recent emails from a folder, newest first. Use this for "what just came in?" / "show my latest inbox messages" when no search filter is needed. By default returns lightweight headers (uid, from, subject, date); set `includeBody=true` to also return the parsed body in one round-trip instead of paying the N+1 cost of calling imap_get_email per message. To filter by sender/subject/date instead, use imap_search_emails.',
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder name"),
      count: z2.coerce.number().default(10).describe("Number of emails to retrieve"),
      includeBody: z2.boolean().default(false).describe("If true, also fetch the parsed message body in the same round-trip and return it alongside headers (avoids the N+1 cost of calling imap_get_email per message). Body is rendered per `bodyFormat` and capped at `bodyMaxLength` characters per field. Off by default to preserve lightweight behavior."),
      bodyFormat: z2.enum(["markdown", "text", "html", "auto"]).default("markdown").describe('How to render the body when `includeBody` is true. Mirrors `imap_get_email` \u2014 "markdown" (default) returns clean Markdown; "text" returns plain text; "html" returns raw HTML; "auto" prefers substantive text/plain, else Markdown.'),
      bodyMaxLength: z2.coerce.number().default(1e4).describe("Per-message cap (in characters) for each rendered body field when `includeBody` is true. Defaults to 10000 to match `imap_get_email`.")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, count, includeBody = false, bodyFormat = "markdown", bodyMaxLength = 1e4 }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const sortedMessages = await imapService2.getLatestEmails(accountId, folder, count, { includeBody, bodyFormat, bodyMaxLength });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          messages: sortedMessages
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_send_email", {
    description: "Compose and send a NEW email via the account's SMTP server (a copy is saved to Sent unless disabled; account defaultBcc addresses are always BCC'd when configured). Use for fresh outbound messages. To respond to an existing message use imap_reply_to_email (keeps threading); to pass a message on use imap_forward_email; to store without sending use imap_save_draft. Supports to/cc/bcc, text and/or HTML, and attachments by base64 content or by file path (see imap_upload_file for large files).",
    inputSchema: {
      ...accountSelector,
      to: z2.string().describe('Recipient email address(es). Either an array of addresses or a single comma-separated string; both accept "Name <addr@example.com>" form.'),
      subject: z2.string().describe("Email subject"),
      text: z2.string().optional().describe("Plain text content"),
      html: z2.string().optional().describe("HTML content"),
      body: z2.string().optional().describe("Alias for 'text' (backward-compat with clients that pass 'body')"),
      cc: addressList("cc", "CC recipients. Either an array of addresses or a single comma-separated string.").optional(),
      bcc: bccSchema,
      replyTo: z2.string().optional().describe("Reply-to address"),
      attachments: z2.array(attachmentSchema).optional().describe("Email attachments")
    }
  }, async ({ accountId: rawAccountId, accountName, to, subject, text, html, body, cc, bcc, replyTo, attachments }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager2.getAccount(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }
    const emailComposer = {
      from: account.email || account.user,
      to,
      subject,
      text: text ?? body,
      html,
      cc,
      bcc: resolveBcc(account, bcc),
      replyTo,
      attachments: buildAttachments(attachments)
    };
    const { messageId, rawMessage } = await smtpService2.sendEmail(accountId, account, emailComposer);
    const sentSave = await saveSentCopy(imapService2, accountId, account, rawMessage);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          messageId,
          ...sentSaveFields(sentSave),
          message: `Email sent successfully${sentSaveSuffix(sentSave)}`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_save_draft", {
    description: "Save an email as a draft in the Drafts folder (no send). Takes the same fields as imap_send_email (including account defaultBcc when configured).",
    inputSchema: {
      ...accountSelector,
      to: z2.string().describe("Recipient email address(es). Either an array of addresses or a single comma-separated string.").optional(),
      subject: z2.string().optional().describe("Email subject"),
      text: z2.string().optional().describe("Plain text content"),
      html: z2.string().optional().describe("HTML content"),
      body: z2.string().optional().describe("Alias for 'text' (backward-compat)"),
      cc: addressList("cc", "CC recipients. Either an array of addresses or a single comma-separated string.").optional(),
      bcc: bccSchema,
      replyTo: z2.string().optional().describe("Reply-to address"),
      inReplyTo: z2.string().optional().describe("Message-Id being replied to"),
      references: addressList("references", "References header value(s)").optional(),
      attachments: z2.array(attachmentSchema).optional().describe("Email attachments"),
      folder: z2.string().optional().describe("Override the Drafts folder name (defaults to auto-detected Drafts folder)")
    }
  }, async ({ accountId: rawAccountId, accountName, to, subject, text, html, body, cc, bcc, replyTo, inReplyTo, references, attachments, folder }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager2.getAccount(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }
    const emailComposer = {
      from: account.email || account.user,
      to: to ?? "",
      subject: subject ?? "",
      text: text ?? body,
      html,
      cc,
      bcc: resolveBcc(account, bcc),
      replyTo,
      inReplyTo,
      references,
      attachments: buildAttachments(attachments)
    };
    const rawMessage = await smtpService2.composeRaw(account, emailComposer);
    const draftsFolder = folder ?? await imapService2.findDraftsFolder(accountId);
    if (!draftsFolder) {
      throw new Error("No Drafts folder found. Tried: Drafts, Draft, INBOX.Drafts, INBOX.Draft, [Gmail]/Drafts. Pass `folder` to override.");
    }
    const appended = await imapService2.appendMessage(accountId, draftsFolder, rawMessage, ["\\Draft", "\\Seen"]);
    if (!appended) {
      throw new Error(`Failed to append draft to folder "${draftsFolder}"`);
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          folder: draftsFolder,
          message: `Draft saved to "${draftsFolder}"`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_reply_to_email", {
    description: `Reply to an existing email identified by folder + uid. Automatically sets the recipient to the original sender, prefixes the subject with "Re:", and preserves threading (In-Reply-To/References). Set replyAll to also include the original recipients. Use this instead of imap_send_email whenever the user is responding to a message already in a mailbox. Account defaultBcc addresses are always BCC'd when configured.`,
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder containing the original email"),
      uid: z2.coerce.number().describe("UID of the email to reply to"),
      text: z2.string().optional().describe("Plain text reply content"),
      html: z2.string().optional().describe("HTML reply content"),
      body: z2.string().optional().describe("Alias for 'text' (backward-compat)"),
      replyAll: z2.boolean().default(false).describe("Reply to all recipients"),
      bcc: bccSchema,
      attachments: z2.array(attachmentSchema).optional().describe("Email attachments")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid, text, html, body, replyAll, bcc, attachments }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager2.getAccount(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }
    const originalEmail = await imapService2.getEmailContent(accountId, folder, uid, { bodyFormat: "text" });
    const extractEmail = (addr) => {
      const match = addr.match(/<([^>]+)>/);
      return (match ? match[1] : addr).trim().toLowerCase();
    };
    const accountEmail = extractEmail(account.email || account.user);
    const recipients = [originalEmail.from];
    if (replyAll) {
      const seen = /* @__PURE__ */ new Set([accountEmail, ...recipients.map(extractEmail)]);
      for (const addr of originalEmail.to) {
        const normalized = extractEmail(addr);
        if (!seen.has(normalized)) {
          recipients.push(addr);
          seen.add(normalized);
        }
      }
    }
    const emailComposer = {
      from: account.email || account.user,
      to: recipients,
      subject: originalEmail.subject.startsWith("Re: ") ? originalEmail.subject : `Re: ${originalEmail.subject}`,
      text: text ?? body,
      html,
      bcc: resolveBcc(account, bcc),
      inReplyTo: originalEmail.messageId,
      references: originalEmail.messageId,
      attachments: buildAttachments(attachments)
    };
    const { messageId, rawMessage } = await smtpService2.sendEmail(accountId, account, emailComposer);
    const sentSave = await saveSentCopy(imapService2, accountId, account, rawMessage);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          messageId,
          ...sentSaveFields(sentSave),
          message: `Reply sent successfully${sentSaveSuffix(sentSave)}`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_forward_email", {
    description: "Forward an existing email (folder + uid) to new recipients, quoting the original message and headers. Optionally include the original attachments. Use when the user wants to pass an existing message on to someone else; use imap_reply_to_email instead to respond to the sender. Account defaultBcc addresses are always BCC'd when configured.",
    inputSchema: {
      ...accountSelector,
      folder: z2.string().default("INBOX").describe("Folder containing the original email"),
      uid: z2.coerce.number().describe("UID of the email to forward"),
      to: z2.string().describe("Forward to email address(es). Either an array of addresses or a single comma-separated string."),
      text: z2.string().optional().describe("Additional text to include"),
      body: z2.string().optional().describe("Alias for 'text' (backward-compat)"),
      bcc: bccSchema,
      includeAttachments: z2.boolean().default(true).describe("Include original attachments")
    }
  }, async ({ accountId: rawAccountId, accountName, folder, uid, to, text, body, bcc, includeAttachments }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager2.getAccount(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }
    const originalEmail = await imapService2.getEmailContent(accountId, folder, uid, { bodyFormat: "html" });
    const forwardHeader = `

---------- Forwarded message ----------
From: ${originalEmail.from}
Date: ${originalEmail.date.toLocaleString()}
Subject: ${originalEmail.subject}
To: ${originalEmail.to.join(", ")}

`;
    const emailComposer = {
      from: account.email || account.user,
      to,
      subject: originalEmail.subject.startsWith("Fwd: ") ? originalEmail.subject : `Fwd: ${originalEmail.subject}`,
      text: (text ?? body ?? "") + forwardHeader + (originalEmail.textContent || ""),
      html: originalEmail.htmlContent,
      bcc: resolveBcc(account, bcc),
      references: originalEmail.messageId
    };
    const { messageId, rawMessage } = await smtpService2.sendEmail(accountId, account, emailComposer);
    const sentSave = await saveSentCopy(imapService2, accountId, account, rawMessage);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          messageId,
          ...sentSaveFields(sentSave),
          message: `Email forwarded successfully${sentSaveSuffix(sentSave)}`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_find_thread_messages", {
    description: "Find messages in `searchFolder` that belong to the same conversation threads as messages already in `sourceFolder`. Useful for catching replies that arrived after a thread was sorted. Works on any IMAP server (uses RFC 3501 HEADER search on In-Reply-To and References). Set `includeBody=true` to also return the parsed body for each found thread message in one round-trip \u2014 avoids the N+1 cost of calling imap_get_email per thread member.",
    inputSchema: {
      ...accountSelector,
      sourceFolder: z2.string().describe('Folder containing the already-sorted thread messages (e.g. "Review.Articles")'),
      searchFolder: z2.string().default("INBOX").describe("Folder to search for related thread messages (default: INBOX)"),
      searchReferences: z2.boolean().optional().describe("Also search the References header for multi-level threads (default: true)"),
      includeBody: z2.boolean().default(false).describe("If true, also fetch the parsed message body for each found thread message in the same round-trip and return it alongside headers (avoids the N+1 cost of calling imap_get_email per thread member). Body is rendered per `bodyFormat` and capped at `bodyMaxLength` characters per field."),
      bodyFormat: z2.enum(["markdown", "text", "html", "auto"]).default("markdown").describe('How to render the body when `includeBody` is true. Mirrors `imap_get_email` \u2014 "markdown" (default) returns clean Markdown; "text" returns plain text; "html" returns raw HTML; "auto" prefers substantive text/plain, else Markdown.'),
      bodyMaxLength: z2.coerce.number().default(1e4).describe("Per-message cap (in characters) for each rendered body field when `includeBody` is true. Defaults to 10000 to match `imap_get_email`.")
    }
  }, async ({ accountId: rawAccountId, accountName, sourceFolder, searchFolder, searchReferences = true, includeBody = false, bodyFormat = "markdown", bodyMaxLength = 1e4 }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    try {
      const result = await imapService2.findThreadMessages(accountId, sourceFolder, searchFolder, {
        searchReferences,
        includeBody,
        bodyFormat,
        bodyMaxLength
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            sourceFolder,
            searchFolder,
            sourceMessageIdCount: result.messageIds.length,
            threadMessageCount: result.uids.length,
            uids: result.uids,
            ...result.messages ? { messages: result.messages } : {}
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            sourceFolder,
            searchFolder,
            error: err instanceof Error ? err.message : "Unknown error"
          }, null, 2)
        }]
      };
    }
  });
  server2.registerTool("imap_find_email_by_message_id", {
    description: "Locate an email by its RFC822 Message-ID across folders and return its current { folder, uid } plus basic envelope. Robust to the message having been moved or archived (IMAP UIDs are folder-relative). Pass the returned folder + uid to imap_reply_to_email or imap_get_email. Without `folders`, searches Gmail \\All Mail when present, else INBOX \u2192 Archive \u2192 Sent \u2192 remaining folders.",
    inputSchema: {
      accountId: z2.string().describe("Account ID"),
      messageId: z2.string().describe("RFC822 Message-ID, with or without angle brackets"),
      folders: z2.array(z2.string()).optional().describe("Explicit folders to search, in order (overrides the default order)")
    }
  }, async ({ accountId, messageId, folders }) => {
    const result = await imapService2.findEmailByMessageId(accountId, messageId, folders);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    };
  });
}

// src/tools/folder-tools.ts
import { z as z3 } from "zod";
var accountSelector2 = {
  accountId: z3.string().optional().describe("Account ID (from imap_list_accounts). Optional if accountName is given or only one account is configured."),
  accountName: z3.string().optional().describe("Account name instead of accountId. Optional if accountId is given or only one account is configured.")
};
function folderTools(server2, imapService2, accountManager2) {
  server2.registerTool("imap_list_folders", {
    description: `List all folders/mailboxes for an account (names, hierarchy delimiter, attributes, RFC 6154 special-use role). Use this first to discover exact folder names before searching, moving, or creating subfolders \u2014 folder naming varies by provider (e.g. "Archive" vs "[Gmail]/All Mail" vs "INBOX.Archive"). The specialUse field ("\\\\Sent", "\\\\Drafts", "\\\\Trash", "\\\\Junk", "\\\\Archive") identifies a folder's role independent of its localized name (e.g. "Gesendet" is the Sent folder when specialUse is "\\\\Sent").`,
    inputSchema: {
      ...accountSelector2
    }
  }, async ({ accountId: rawAccountId, accountName }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const folders = await imapService2.listFolders(accountId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          folders: folders.map((folder) => ({
            name: folder.name,
            delimiter: folder.delimiter,
            attributes: folder.attributes,
            // RFC 6154 special-use role (language-independent): lets callers
            // find e.g. the Sent folder even when it is named "Gesendet".
            specialUse: folder.specialUse,
            hasChildren: !!folder.children && folder.children.length > 0
          }))
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_folder_status", {
    description: "Get status information about a folder",
    inputSchema: {
      ...accountSelector2,
      folder: z3.string().describe("Folder name")
    }
  }, async ({ accountId: rawAccountId, accountName, folder }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const status = await imapService2.getFolderStatus(accountId, folder);
    const box = await imapService2.selectFolder(accountId, folder);
    const toFlagArray = (flags2) => Array.from(flags2 ?? []);
    const flags = toFlagArray(box.flags);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          folder,
          messages: {
            total: status.messages,
            new: status.recent,
            unseen: status.unseen
          },
          uidvalidity: status.uidValidity,
          uidnext: status.uidNext,
          flags,
          permanentFlags: toFlagArray(box.permanentFlags),
          customKeywords: flags.filter((f) => !isSystemFlag(f))
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_create_folder", {
    description: 'Create a new IMAP folder/mailbox. Most servers also create any missing parent folders (e.g. creating "Archives/2026/2026-05" auto-creates "Archives" and "Archives/2026"). Returns success even if the folder already exists.',
    inputSchema: {
      ...accountSelector2,
      folder: z3.string().describe('Full folder path to create (e.g. "Archives/2026/2026-05" or "INBOX.Archive")')
    }
  }, async ({ accountId: rawAccountId, accountName, folder }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    try {
      const result = await imapService2.createFolder(accountId, folder);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            folder: result.path,
            created: result.created,
            alreadyExisted: result.alreadyExisted,
            message: result.alreadyExisted ? `Folder "${result.path}" already existed` : `Folder "${result.path}" created`
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            folder,
            error: err instanceof Error ? err.message : "Unknown error"
          }, null, 2)
        }]
      };
    }
  });
  server2.registerTool("imap_get_unread_count", {
    description: 'Count unread (unseen) emails per folder, plus a total. Use for "how many unread do I have?" overviews. Defaults to all folders; pass a folders list to limit scope and speed it up.',
    inputSchema: {
      ...accountSelector2,
      folders: z3.array(z3.string()).optional().describe("List of folders to check (default: all)")
    }
  }, async ({ accountId: rawAccountId, accountName, folders }) => {
    const accountId = accountManager2.resolveAccountId(rawAccountId, accountName);
    const allFolders = await imapService2.listFolders(accountId);
    const foldersToCheck = folders || allFolders.map((f) => f.name);
    const unreadCounts = {};
    let totalUnread = 0;
    for (const folderName of foldersToCheck) {
      try {
        const unreadMessages = await imapService2.searchEmails(accountId, folderName, { seen: false });
        const count = unreadMessages.length;
        unreadCounts[folderName] = count;
        totalUnread += count;
      } catch (error) {
        unreadCounts[folderName] = 0;
      }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          totalUnread,
          byFolder: unreadCounts
        }, null, 2)
      }]
    };
  });
}

// src/tools/spam-tools.ts
import { z as z4 } from "zod";
function spamTools(server2, imapService2, spamService2) {
  server2.registerTool("imap_check_spam", {
    description: "Check emails in a folder for spam. Combines sender-domain checks (known spam/disposable domains, suspicious patterns) with deterministic raw-header analysis: bulk-mailer X-Mailer/User-Agent signatures, Precedence: bulk, DMARC/SPF/DKIM failures in Authentication-Results, and List-Unsubscribe / Reply-To domains that do not match the sender. Header checks catch scam mail from fresh, unlisted domains that pass the domain check. Returns domain-based spam, a separate list of header-flagged mails, and domain statistics.",
    inputSchema: {
      accountId: z4.string().describe("Account ID"),
      folder: z4.string().default("INBOX").describe("Folder name"),
      limit: z4.coerce.number().default(100).describe("Maximum number of emails to check"),
      from: z4.string().optional().describe("Filter by sender (optional)"),
      since: z4.string().optional().describe("Check emails since date (YYYY-MM-DD)"),
      includeHeaderChecks: z4.boolean().default(true).describe("Also run deterministic raw-header checks (X-Mailer bulk tools, Precedence: bulk, DMARC/SPF/DKIM failures, List-Unsubscribe/Reply-To domain mismatches) on top of the sender-domain check. Fetches message headers in one extra batch round-trip. Set false to skip header analysis and only check sender domains.")
    }
  }, async ({ accountId, folder, limit, from, since, includeHeaderChecks }) => {
    const criteria = {};
    if (from) criteria.from = from;
    if (since) criteria.since = new Date(since);
    const messages = await imapService2.searchEmails(accountId, folder, criteria);
    const limitedMessages = messages.slice(0, limit);
    const emailData = limitedMessages.map((m) => ({
      uid: m.uid,
      from: m.from,
      subject: m.subject
    }));
    const result = spamService2.checkEmails(emailData);
    const headerFlagsByUid = /* @__PURE__ */ new Map();
    if (includeHeaderChecks && limitedMessages.length > 0) {
      const headersByUid = await imapService2.fetchHeadersForUids(
        accountId,
        folder,
        limitedMessages.map((m) => m.uid)
      );
      for (const m of limitedMessages) {
        const h = headersByUid.get(m.uid);
        if (!h) continue;
        const flags = spamService2.checkHeaders(h, m.from);
        if (flags.length > 0) headerFlagsByUid.set(m.uid, flags);
      }
    }
    const domainSpamUids = new Set(result.spam.map((s) => s.uid));
    const headerFlagged = limitedMessages.filter((m) => headerFlagsByUid.has(m.uid) && !domainSpamUids.has(m.uid)).map((m) => ({
      uid: m.uid,
      from: m.from,
      subject: m.subject,
      headerRedFlags: headerFlagsByUid.get(m.uid)
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          totalChecked: limitedMessages.length,
          spamCount: result.spam.length,
          cleanCount: result.clean.length,
          headerFlaggedCount: headerFlagged.length,
          spamEmails: result.spam.map((s) => ({
            uid: s.uid,
            from: s.email,
            subject: s.subject,
            domain: s.domain,
            reason: s.reason,
            confidence: s.confidence,
            headerRedFlags: headerFlagsByUid.get(s.uid)
          })),
          headerFlagged,
          topDomains: result.domainStats.slice(0, 20),
          message: `Found ${result.spam.length} domain-based spam${includeHeaderChecks ? ` and ${headerFlagged.length} more with header red flags` : ""} out of ${limitedMessages.length} checked`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_delete_spam", {
    description: "Find and delete emails from known spam/disposable email domains.",
    inputSchema: {
      accountId: z4.string().describe("Account ID"),
      folder: z4.string().default("INBOX").describe("Folder name"),
      limit: z4.coerce.number().default(500).describe("Maximum number of emails to check"),
      minConfidence: z4.enum(["high", "medium", "low"]).default("high").describe("Minimum confidence level for spam detection"),
      dryRun: z4.boolean().default(true).describe("If true, only report what would be deleted without deleting")
    }
  }, async ({ accountId, folder, limit, minConfidence, dryRun }) => {
    const messages = await imapService2.searchEmails(accountId, folder, {});
    const limitedMessages = messages.slice(0, limit);
    const emailData = limitedMessages.map((m) => ({
      uid: m.uid,
      from: m.from,
      subject: m.subject
    }));
    const result = spamService2.checkEmails(emailData);
    const confidenceLevels = ["high", "medium", "low"];
    const minIndex = confidenceLevels.indexOf(minConfidence);
    const toDelete = result.spam.filter((s) => {
      const idx = confidenceLevels.indexOf(s.confidence);
      return idx <= minIndex;
    });
    if (toDelete.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            found: 0,
            deleted: 0,
            message: "No spam emails found matching the criteria"
          }, null, 2)
        }]
      };
    }
    if (dryRun) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            dryRun: true,
            found: toDelete.length,
            wouldDelete: toDelete.length,
            samples: toDelete.slice(0, 20).map((s) => ({
              uid: s.uid,
              from: s.email,
              subject: s.subject,
              domain: s.domain,
              reason: s.reason,
              confidence: s.confidence
            })),
            message: `Would delete ${toDelete.length} spam emails (dry run). Set dryRun=false to actually delete.`
          }, null, 2)
        }]
      };
    }
    const uids = toDelete.map((s) => s.uid);
    const deleteResult = await imapService2.bulkDelete(accountId, folder, uids);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: deleteResult.failed === 0,
          found: toDelete.length,
          deleted: deleteResult.deleted,
          failed: deleteResult.failed,
          errors: deleteResult.errors.length > 0 ? deleteResult.errors : void 0,
          message: deleteResult.failed === 0 ? `Successfully deleted ${deleteResult.deleted} spam emails` : `Deleted ${deleteResult.deleted} spam emails, ${deleteResult.failed} failed`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_domain_stats", {
    description: "Get statistics about sender domains in a folder. Useful for identifying bulk senders or spam patterns.",
    inputSchema: {
      accountId: z4.string().describe("Account ID"),
      folder: z4.string().default("INBOX").describe("Folder name"),
      limit: z4.coerce.number().default(500).describe("Maximum number of emails to analyze"),
      minCount: z4.coerce.number().default(2).describe("Minimum email count per domain to include")
    }
  }, async ({ accountId, folder, limit, minCount }) => {
    const messages = await imapService2.searchEmails(accountId, folder, {});
    const limitedMessages = messages.slice(0, limit);
    const emailData = limitedMessages.map((m) => ({
      uid: m.uid,
      from: m.from,
      subject: m.subject
    }));
    const result = spamService2.checkEmails(emailData);
    const filteredStats = result.domainStats.filter((d) => d.count >= minCount).map((d) => ({
      domain: d.domain,
      count: d.count,
      isKnownSpam: spamService2.checkEmail(`test@${d.domain}`).isSpam,
      samples: d.emails.slice(0, 3).map((e) => ({
        from: e.from,
        subject: e.subject
      }))
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          totalEmails: limitedMessages.length,
          uniqueDomains: result.domainStats.length,
          domainsWithMultiple: filteredStats.length,
          domains: filteredStats
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_add_spam_domain", {
    description: "Add a domain to the custom spam list. Emails from this domain will be flagged as spam.",
    inputSchema: {
      domain: z4.string().describe('Domain to add to spam list (e.g., "spammer.com")')
    }
  }, async ({ domain }) => {
    spamService2.addSpamDomain(domain);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Domain "${domain}" added to spam list`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_remove_spam_domain", {
    description: "Remove a domain from the custom spam list.",
    inputSchema: {
      domain: z4.string().describe("Domain to remove from spam list")
    }
  }, async ({ domain }) => {
    spamService2.removeSpamDomain(domain);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Domain "${domain}" removed from spam list`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_add_whitelist_domain", {
    description: "Add a domain to the whitelist. Emails from whitelisted domains will never be flagged as spam.",
    inputSchema: {
      domain: z4.string().describe('Domain to whitelist (e.g., "trusted.com")')
    }
  }, async ({ domain }) => {
    spamService2.addWhitelistDomain(domain);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message: `Domain "${domain}" added to whitelist`
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_list_spam_domains", {
    description: "List all known spam domains (built-in and custom).",
    inputSchema: {}
  }, async () => {
    const spamDomains = spamService2.getKnownSpamDomains();
    const whitelistDomains = spamService2.getWhitelistDomains();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          spamDomainsCount: spamDomains.length,
          spamDomains: spamDomains.slice(0, 100),
          whitelistDomainsCount: whitelistDomains.length,
          whitelistDomains,
          note: spamDomains.length > 100 ? `Showing first 100 of ${spamDomains.length} domains` : void 0
        }, null, 2)
      }]
    };
  });
  server2.registerTool("imap_delete_by_domain", {
    description: "Delete all emails from a specific domain. Useful for cleaning up unwanted newsletters or spam.",
    inputSchema: {
      accountId: z4.string().describe("Account ID"),
      folder: z4.string().default("INBOX").describe("Folder name"),
      domain: z4.string().describe('Domain to delete emails from (e.g., "spammer.com")'),
      dryRun: z4.boolean().default(true).describe("If true, only report what would be deleted")
    }
  }, async ({ accountId, folder, domain, dryRun }) => {
    const messages = await imapService2.searchEmails(accountId, folder, {
      from: `@${domain}`
    });
    if (messages.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            found: 0,
            deleted: 0,
            message: `No emails found from domain "${domain}"`
          }, null, 2)
        }]
      };
    }
    if (dryRun) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            dryRun: true,
            domain,
            found: messages.length,
            wouldDelete: messages.length,
            samples: messages.slice(0, 10).map((m) => ({
              uid: m.uid,
              from: m.from,
              subject: m.subject,
              date: m.date
            })),
            message: `Would delete ${messages.length} emails from "${domain}" (dry run). Set dryRun=false to actually delete.`
          }, null, 2)
        }]
      };
    }
    const uids = messages.map((m) => m.uid);
    const result = await imapService2.bulkDelete(accountId, folder, uids);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: result.failed === 0,
          domain,
          found: messages.length,
          deleted: result.deleted,
          failed: result.failed,
          errors: result.errors.length > 0 ? result.errors : void 0,
          message: result.failed === 0 ? `Successfully deleted ${result.deleted} emails from "${domain}"` : `Deleted ${result.deleted} emails from "${domain}", ${result.failed} failed`
        }, null, 2)
      }]
    };
  });
}

// src/tools/index.ts
var READ_ONLY_TOOLS = [
  // Account (non-mutating)
  "imap_list_accounts",
  "imap_connect",
  "imap_disconnect",
  "imap_test_account",
  // Email (read)
  "imap_search_emails",
  "imap_get_email",
  "imap_get_latest_emails",
  "imap_download_attachment",
  "imap_find_thread_messages",
  "imap_find_email_by_message_id",
  // Folder (read)
  "imap_list_folders",
  "imap_folder_status",
  "imap_get_unread_count",
  // Spam (read / analysis only)
  "imap_check_spam",
  "imap_domain_stats",
  "imap_list_spam_domains"
];
function normalizeToolName(name) {
  const trimmed = name.trim().toLowerCase();
  return trimmed.startsWith("imap_") ? trimmed : `imap_${trimmed}`;
}
function parseToolList(value) {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean).map(normalizeToolName);
}
function isTruthy(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
function resolveEnabledTools(env = process.env) {
  const explicit = parseToolList(env.IMAP_MCP_ENABLED_TOOLS);
  if (explicit.length > 0) {
    return new Set(explicit);
  }
  if (isTruthy(env.IMAP_MCP_READ_ONLY)) {
    return new Set(READ_ONLY_TOOLS);
  }
  return null;
}
function createFilteredServer(server2, allowed, seen, registered) {
  const handler = {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name, ...rest) => {
          seen.add(name);
          if (!allowed.has(name)) {
            return void 0;
          }
          registered.push(name);
          return target.registerTool(name, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  };
  return new Proxy(server2, handler);
}
function registerTools(server2, imapService2, accountManager2, smtpService2, spamService2) {
  const enabled = resolveEnabledTools();
  const seen = /* @__PURE__ */ new Set();
  const registered = [];
  const target = enabled ? createFilteredServer(server2, enabled, seen, registered) : server2;
  accountTools(target, accountManager2, imapService2, smtpService2);
  emailTools(target, imapService2, accountManager2, smtpService2);
  folderTools(target, imapService2, accountManager2);
  spamTools(target, imapService2, spamService2);
  if (enabled) {
    const skipped = seen.size - registered.length;
    console.error(
      `[imap-mcp] Tool access restricted: ${registered.length} enabled, ${skipped} disabled.`
    );
    const unknown = [...enabled].filter((name) => !seen.has(name));
    if (unknown.length > 0) {
      console.error(
        `[imap-mcp] Warning: ignoring unknown tool name(s) in IMAP_MCP_ENABLED_TOOLS: ${unknown.join(", ")}`
      );
    }
  }
}

// src/index.ts
var originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function(chunk, encoding, callback) {
  if (typeof chunk === "string" && (chunk.startsWith("{") || chunk === "\n")) {
    return originalWrite(chunk, encoding, callback);
  }
  return true;
};
dotenv.config();
var server = new McpServer({
  name: "imap-mcp-server",
  version: "1.0.0"
});
var imapService = new ImapService();
var accountManager = new AccountManager();
var smtpService = new SmtpService();
var spamService = new SpamService();
imapService.setAccountManager(accountManager);
registerTools(server, imapService, accountManager, smtpService, spamService);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("IMAP MCP Server started");
}
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
