import { describe, it, expect } from "vitest";
// Plain ESM helper, shared with the container start command.
import { decideOnChildExit, decideOnChildError } from "../scripts/supervisor.mjs";

describe("child exit supervision", () => {
  it("fails the container when the bot dies on its own", () => {
    // The bug this guards: nothing watched the bot, so a crashed bot left the
    // web server (and therefore the platform's health view) perfectly happy
    // while the shop had silently stopped selling.
    const d = decideOnChildExit({ name: "bot", code: 1, signal: null, shuttingDown: false });
    expect(d.action).toBe("exit");
    expect(d.code).toBe(1);
    expect(d.reason).toContain("bot");
  });

  it("fails even when a child exits with code 0", () => {
    // Neither child should ever finish by itself; a clean exit is still a fault,
    // and reporting 0 would tell the platform everything is fine.
    const d = decideOnChildExit({ name: "next", code: 0, signal: null, shuttingDown: false });
    expect(d.action).toBe("exit");
    expect(d.code).not.toBe(0);
  });

  it("preserves a non-zero child exit code", () => {
    expect(decideOnChildExit({ name: "bot", code: 137, signal: null, shuttingDown: false }).code).toBe(137);
  });

  it("fails when a child is killed by a signal", () => {
    const d = decideOnChildExit({ name: "bot", code: null, signal: "SIGKILL", shuttingDown: false });
    expect(d.action).toBe("exit");
    expect(d.code).toBe(1);
    expect(d.reason).toContain("SIGKILL");
  });

  it("stays quiet for children exiting during a shutdown", () => {
    // A platform SIGTERM kills both children; that must not be reported as a
    // crash or race the graceful exit.
    for (const code of [0, 1, null]) {
      expect(decideOnChildExit({ name: "next", code, signal: "SIGTERM", shuttingDown: true }).action).toBe("ignore");
    }
  });
});

describe("child spawn error supervision", () => {
  it("fails the container when a child cannot start", () => {
    const d = decideOnChildError({ name: "bot", message: "spawn npx ENOENT", shuttingDown: false });
    expect(d.action).toBe("exit");
    expect(d.code).toBe(1);
    expect(d.reason).toContain("ENOENT");
  });

  it("stays quiet for errors during a shutdown", () => {
    expect(decideOnChildError({ name: "bot", message: "killed", shuttingDown: true }).action).toBe("ignore");
  });
});
