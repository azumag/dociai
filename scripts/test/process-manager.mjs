import { spawn } from "node:child_process";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export class ManagedProcess {
  #child;
  #logs = [];
  #stopped = false;

  constructor(name, command, args = [], options = {}) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.options = options;
  }

  start() {
    if (this.#child) throw new Error(`${this.name} is already started`);

    this.#child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const collect = (stream, prefix) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const text = String(chunk);
        this.#logs.push(`${prefix}${text}`);
        if (this.options.pipeOutput !== false) process.stderr.write(`${prefix}${text}`);
      });
    };

    collect(this.#child.stdout, `[${this.name}] `);
    collect(this.#child.stderr, `[${this.name}:err] `);

    this.#child.on("error", (error) => {
      this.#logs.push(`[spawn-error] ${error.stack ?? error.message}\n`);
    });

    return this;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  logs() {
    return this.#logs.join("");
  }

  async waitForExit() {
    if (!this.#child) throw new Error(`${this.name} has not been started`);
    return await new Promise((resolve, reject) => {
      this.#child.once("error", reject);
      this.#child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  async stop({ timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
    if (!this.#child || this.#stopped) return;
    this.#stopped = true;

    const child = this.#child;
    if (child.exitCode !== null) return;

    const exited = new Promise((resolve) => child.once("exit", resolve));
    terminateTree(child, "SIGTERM");

    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), timeoutMs)),
    ]);

    if (timedOut && child.exitCode === null) {
      terminateTree(child, "SIGKILL");
      await exited;
    }
  }
}

function terminateTree(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      killer.unref();
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
