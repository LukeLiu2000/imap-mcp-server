// src/web/server.ts
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path2 from "path";
import fs2 from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import open from "open";

// src/services/account-manager.ts
import { promises as fs } from "fs";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

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

// src/services/account-manager.ts
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
  setAccountManager(accountManager) {
    this.accountManager = accountManager;
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
    const uidList = Array.isArray(uids) ? uids : [uids];
    if (uidList.length === 0) {
      return { success: true, marked: [], failed: [] };
    }
    const client = await this.ensureConnected(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderName);
      const target = uidList.length === 1 ? uidList[0] : uidList.join(",");
      if (mode === "add") {
        await client.messageFlagsAdd(target, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(target, ["\\Seen"], { uid: true });
      }
      return { success: true, marked: [...uidList], failed: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return {
        success: false,
        marked: [],
        failed: [...uidList],
        errors: [`Failed to ${mode === "add" ? "mark as read" : "mark as unread"} UIDs [${uidList.join(", ")}]: ${message}`]
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
    const uidList = isBatch ? uids : [uids];
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
      for (const uid of uidList) {
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
      const path3 = result && typeof result === "object" && "path" in result ? result.path : folderPath;
      const created = result && typeof result === "object" && "created" in result ? Boolean(result.created) : true;
      return {
        path: path3,
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

// src/providers/email-providers.ts
var emailProviders = [
  {
    id: "gmail",
    name: "Gmail",
    displayName: "Google Mail",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/gmail.svg",
    color: "#EA4335",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecurity: "SSL",
    domains: ["gmail.com", "googlemail.com"],
    helpUrl: "https://support.google.com/mail/answer/7126229",
    requiresAppPassword: true,
    oauth2Supported: true,
    notes: 'Requires app-specific password or OAuth2. Enable "Less secure app access" or use App Password with 2FA.'
  },
  {
    id: "outlook",
    name: "Outlook",
    displayName: "Microsoft Outlook",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/microsoftoutlook.svg",
    color: "#0078D4",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapSecurity: "TLS",
    smtpHost: "smtp-mail.outlook.com",
    smtpPort: 587,
    smtpSecurity: "STARTTLS",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    helpUrl: "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353",
    oauth2Supported: true
  },
  {
    id: "yahoo",
    name: "Yahoo",
    displayName: "Yahoo Mail",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/yahoo.svg",
    color: "#6001D2",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecurity: "SSL",
    domains: ["yahoo.com", "yahoo.de", "yahoo.co.uk", "ymail.com"],
    helpUrl: "https://help.yahoo.com/kb/SLN4075.html",
    requiresAppPassword: true,
    notes: "Requires app-specific password. Generate one in Yahoo Account Security settings."
  },
  {
    id: "icloud",
    name: "iCloud",
    displayName: "Apple iCloud Mail",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/icloud.svg",
    color: "#007AFF",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecurity: "STARTTLS",
    domains: ["icloud.com", "me.com", "mac.com"],
    helpUrl: "https://support.apple.com/en-us/HT202304",
    requiresAppPassword: true,
    notes: "Requires app-specific password if 2FA is enabled."
  },
  {
    id: "gmx",
    name: "GMX",
    displayName: "GMX Mail",
    iconUrl: "https://upload.wikimedia.org/wikipedia/commons/4/4e/GMX_logo.svg",
    color: "#FF6900",
    imapHost: "imap.gmx.net",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "mail.gmx.net",
    smtpPort: 587,
    smtpSecurity: "STARTTLS",
    domains: ["gmx.net", "gmx.de", "gmx.at", "gmx.ch", "gmx.com"],
    helpUrl: "https://support.gmx.com/pop-imap/imap/index.html"
  },
  {
    id: "webde",
    name: "Web.de",
    displayName: "WEB.DE Mail",
    iconUrl: "https://upload.wikimedia.org/wikipedia/commons/f/f2/Web.de_logo.svg",
    color: "#FFCC00",
    imapHost: "imap.web.de",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "smtp.web.de",
    smtpPort: 587,
    smtpSecurity: "STARTTLS",
    domains: ["web.de"],
    helpUrl: "https://hilfe.web.de/pop-imap/imap/index.html"
  },
  {
    id: "ionos",
    name: "IONOS",
    displayName: "IONOS Mail (1&1)",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/ionos.svg",
    color: "#003D8F",
    imapHost: "imap.ionos.de",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "smtp.ionos.de",
    smtpPort: 587,
    smtpSecurity: "STARTTLS",
    domains: ["ionos.de", "1und1.de", "1and1.com"],
    helpUrl: "https://www.ionos.de/hilfe/e-mail/e-mail-konto-in-e-mail-programm-einrichten/imap-posteingangsserver-und-postausgangsserver/",
    notes: "Use your full email address as username."
  },
  {
    id: "mailbox",
    name: "Mailbox.org",
    displayName: "mailbox.org",
    iconUrl: "https://mailbox.org/favicon.ico",
    color: "#5CB85C",
    imapHost: "imap.mailbox.org",
    imapPort: 993,
    imapSecurity: "TLS",
    smtpHost: "smtp.mailbox.org",
    smtpPort: 587,
    smtpSecurity: "STARTTLS",
    domains: ["mailbox.org"],
    helpUrl: "https://kb.mailbox.org/en/private/e-mail-article/manual-configuration-of-e-mail-programs"
  },
  {
    id: "posteo",
    name: "Posteo",
    displayName: "Posteo",
    iconUrl: "https://posteo.de/favicon.ico",
    color: "#8CC63F",
    imapHost: "posteo.de",
    imapPort: 993,
    imapSecurity: "TLS",
    smtpHost: "posteo.de",
    smtpPort: 587,
    smtpSecurity: "STARTTLS",
    domains: ["posteo.de", "posteo.net"],
    helpUrl: "https://posteo.de/en/help/how-do-i-set-up-posteo-in-an-email-client-pop3-imap-and-smtp"
  },
  {
    id: "aol",
    name: "AOL",
    displayName: "AOL Mail",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/aol.svg",
    color: "#FF0B00",
    imapHost: "imap.aol.com",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "smtp.aol.com",
    smtpPort: 465,
    smtpSecurity: "SSL",
    domains: ["aol.com", "aol.de"],
    helpUrl: "https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail",
    requiresAppPassword: true
  },
  {
    id: "office365",
    name: "Office365",
    displayName: "Microsoft 365",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/microsoft365.svg",
    color: "#0078D4",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapSecurity: "TLS",
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecurity: "STARTTLS",
    domains: [],
    helpUrl: "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353",
    notes: "For business/organization accounts. Use full email as username.",
    oauth2Supported: true
  },
  {
    id: "zoho",
    name: "Zoho",
    displayName: "Zoho Mail",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/zoho.svg",
    color: "#C83C2B",
    imapHost: "imap.zoho.com",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    smtpSecurity: "SSL",
    domains: ["zoho.com", "zohomail.com"],
    helpUrl: "https://www.zoho.com/mail/help/imap-access.html",
    notes: "Enable IMAP access in Zoho Mail settings first."
  },
  {
    id: "protonmail",
    name: "ProtonMail",
    displayName: "Proton Mail",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/protonmail.svg",
    color: "#6D4AFF",
    imapHost: "127.0.0.1",
    imapPort: 1143,
    imapSecurity: "STARTTLS",
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    smtpSecurity: "STARTTLS",
    domains: ["protonmail.com", "proton.me", "pm.me"],
    helpUrl: "https://proton.me/support/protonmail-bridge-install",
    notes: "Requires ProtonMail Bridge application running locally. Paid accounts only."
  },
  {
    id: "fastmail",
    name: "Fastmail",
    displayName: "Fastmail",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/fastmail.svg",
    color: "#2E5CFF",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    imapSecurity: "SSL",
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecurity: "SSL",
    domains: ["fastmail.com", "fastmail.fm"],
    helpUrl: "https://www.fastmail.help/hc/en-us/articles/1500000278342",
    requiresAppPassword: true,
    notes: "Requires app-specific password. Create one in Settings > Privacy & Security."
  },
  {
    id: "custom",
    name: "Custom",
    displayName: "Custom/Other Provider",
    iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@v10/icons/mail.svg",
    color: "#6B7280",
    imapHost: "",
    imapPort: 993,
    imapSecurity: "SSL",
    domains: [],
    notes: "Enter your email provider's IMAP settings manually."
  }
];
function getProviderByEmail(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return void 0;
  return emailProviders.find(
    (provider) => provider.domains.some((d) => domain.endsWith(d))
  );
}

// src/web/server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
function stripAccountSecrets(account) {
  const { password: _password, ...rest } = account;
  const safe = { ...rest };
  if (safe.smtp && typeof safe.smtp === "object" && "password" in safe.smtp) {
    safe.smtp = { ...safe.smtp };
    delete safe.smtp.password;
  }
  return safe;
}
var WebUIServer = class _WebUIServer {
  app;
  accountManager;
  imapService;
  port;
  constructor(port = 3e3, deps = {}) {
    this.app = express();
    this.port = port;
    this.accountManager = deps.accountManager ?? new AccountManager();
    this.imapService = deps.imapService ?? new ImapService();
    this.setupMiddleware();
    this.setupRoutes();
  }
  /** The configured Express application. Exposed for tests. */
  getApp() {
    return this.app;
  }
  setupMiddleware() {
    this.app.use(this.loopbackOnly());
    this.app.use(cors());
    this.app.use(bodyParser.json());
    this.app.use(express.static(this.resolvePublicDir()));
  }
  static isLoopbackName(name) {
    const n = name.toLowerCase();
    return n === "localhost" || n === "127.0.0.1" || n === "::1";
  }
  // Guard: allow only loopback Host + (when present) loopback Origin. Non-browser
  // clients (curl, tests) send no Origin and are allowed if the Host is loopback.
  loopbackOnly() {
    const hostname = (hostHeader) => hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return (req, res, next) => {
      const host = req.headers.host;
      if (!host || !_WebUIServer.isLoopbackName(hostname(host))) {
        res.status(403).json({ error: "Forbidden: the setup API is reachable on loopback only." });
        return;
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost;
        try {
          originHost = new URL(origin).hostname;
        } catch {
          res.status(403).json({ error: "Forbidden: invalid Origin." });
          return;
        }
        if (!_WebUIServer.isLoopbackName(originHost)) {
          res.status(403).json({ error: "Forbidden: cross-origin requests are not allowed." });
          return;
        }
      }
      next();
    };
  }
  // The bundled entrypoint may live at dist/web/server.js (npm run web) or be
  // inlined into dist/setup.js, so __dirname differs. Probe the likely
  // locations and fall back to the current working directory.
  resolvePublicDir() {
    const candidates = [
      path2.join(__dirname, "../../public"),
      path2.join(__dirname, "../public"),
      path2.join(process.cwd(), "public")
    ];
    const found = candidates.find((dir) => fs2.existsSync(path2.join(dir, "index.html")));
    return found ?? candidates[0];
  }
  setupRoutes() {
    this.app.get("/api/providers", (req, res) => {
      res.json(emailProviders);
    });
    this.app.get("/api/accounts", (req, res) => {
      try {
        const accounts = this.accountManager.getAllAccounts();
        res.json(accounts.map(stripAccountSecrets));
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch accounts" });
      }
    });
    this.app.post("/api/accounts", async (req, res) => {
      try {
        const {
          name,
          email,
          password,
          host,
          port,
          tls,
          smtp,
          imapUsername,
          sentFolder,
          defaultBcc,
          imapUsernameFromEnv,
          imapPasswordFromEnv,
          smtpUsernameFromEnv,
          smtpPasswordFromEnv
        } = req.body;
        let imapHost = host;
        let imapPort = port;
        let useTls = tls;
        if (!host && email) {
          const provider = getProviderByEmail(email);
          if (provider) {
            imapHost = provider.imapHost;
            imapPort = provider.imapPort;
            useTls = provider.imapSecurity !== "STARTTLS";
          }
        }
        const account = await this.accountManager.addAccount({
          name: name || email,
          host: imapHost,
          port: imapPort || 993,
          user: imapUsernameFromEnv ? "" : imapUsername || email,
          password: imapPasswordFromEnv ? "" : password,
          tls: useTls !== false,
          ...imapUsername || imapUsernameFromEnv ? { email } : {},
          smtp: smtp ? {
            ...smtp,
            ...smtpUsernameFromEnv ? { user: "" } : {},
            ...smtpPasswordFromEnv ? { password: "" } : {}
          } : void 0,
          ...typeof sentFolder === "string" && sentFolder ? { sentFolder } : {},
          ...defaultBcc !== void 0 && defaultBcc !== "" && !(Array.isArray(defaultBcc) && defaultBcc.length === 0) ? { defaultBcc } : {}
        });
        res.json({ success: true, account: stripAccountSecrets(account) });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Failed to add account"
        });
      }
    });
    this.app.post("/api/test-connection", async (req, res) => {
      try {
        const { email, password, host, port, tls, imapUsername } = req.body;
        const testAccount = {
          id: "test-" + Date.now(),
          name: "Test",
          host: host || "imap.gmail.com",
          port: port || 993,
          user: imapUsername || email,
          password,
          tls: tls !== false
        };
        await this.imapService.connect(testAccount);
        const folders = await this.imapService.listFolders(testAccount.id);
        await this.imapService.disconnect(testAccount.id);
        res.json({
          success: true,
          folders: folders.map((f) => f.name)
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Connection test failed"
        });
      }
    });
    this.app.delete("/api/accounts/:id", async (req, res) => {
      try {
        await this.accountManager.removeAccount(req.params.id);
        res.json({ success: true });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Failed to remove account"
        });
      }
    });
    this.app.put("/api/accounts/:id", async (req, res) => {
      try {
        const {
          name,
          email,
          password,
          host,
          port,
          tls,
          smtp,
          saveToSent,
          imapUsername,
          sentFolder,
          defaultBcc,
          imapUsernameFromEnv,
          imapPasswordFromEnv,
          smtpUsernameFromEnv,
          smtpPasswordFromEnv
        } = req.body;
        const updates = {};
        if (name !== void 0) updates.name = name;
        if (imapUsernameFromEnv) {
          updates.user = "";
          if (email !== void 0) updates.email = email;
        } else if (imapUsername) {
          updates.user = imapUsername;
          if (email !== void 0) updates.email = email;
        } else if (email !== void 0) {
          updates.user = email;
          updates.email = void 0;
        }
        if (imapPasswordFromEnv) {
          updates.password = "";
        } else if (password !== void 0) {
          updates.password = password;
        }
        if (host !== void 0) updates.host = host;
        if (port !== void 0) updates.port = port;
        if (tls !== void 0) updates.tls = tls;
        if (smtp !== void 0) {
          updates.smtp = {
            ...smtp,
            ...smtpUsernameFromEnv ? { user: "" } : {},
            ...smtpPasswordFromEnv ? { password: "" } : {}
          };
        }
        if (saveToSent !== void 0) updates.saveToSent = saveToSent;
        if (typeof sentFolder === "string") updates.sentFolder = sentFolder === "" ? void 0 : sentFolder;
        if (defaultBcc !== void 0) {
          if (defaultBcc === "" || Array.isArray(defaultBcc) && defaultBcc.length === 0) {
            updates.defaultBcc = void 0;
          } else {
            updates.defaultBcc = defaultBcc;
          }
        }
        const account = await this.accountManager.updateAccount(req.params.id, updates);
        res.json({ success: true, account: stripAccountSecrets(account) });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Failed to update account"
        });
      }
    });
    this.app.get("/api/accounts/:id", async (req, res) => {
      try {
        const account = this.accountManager.getAccount(req.params.id);
        if (!account) {
          res.status(404).json({ success: false, error: "Account not found" });
        } else {
          res.json({ success: true, account: stripAccountSecrets(account) });
        }
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Failed to get account"
        });
      }
    });
    this.app.post("/api/accounts/:id/test", async (req, res) => {
      try {
        const account = this.accountManager.getAccount(req.params.id);
        if (!account) {
          res.status(404).json({ success: false, error: "Account not found" });
          return;
        }
        const result = await this.imapService.testConnection(account);
        res.json({
          success: result.success,
          accountId: account.id,
          accountName: account.name,
          host: account.host,
          folders: result.folders,
          messageCount: result.messageCount,
          error: result.error
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : "Test failed"
        });
      }
    });
    this.app.get("/api/health", (req, res) => {
      res.json({ status: "ok", version: "1.0.0" });
    });
  }
  async start(autoOpen = true) {
    return new Promise((resolve) => {
      const server = this.app.listen(this.port, () => {
        console.log(`\u{1F310} Web UI server running at http://localhost:${this.port}`);
        if (autoOpen) {
          setTimeout(() => {
            open(`http://localhost:${this.port}`);
          }, 1e3);
        }
        resolve();
      });
      process.on("SIGINT", () => {
        console.log("\nShutting down web server...");
        server.close(() => {
          process.exit(0);
        });
      });
    });
  }
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parseInt(process.env.PORT || "3000");
  const server = new WebUIServer(port);
  server.start();
}
export {
  WebUIServer
};
