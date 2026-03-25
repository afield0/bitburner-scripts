import { VERSION } from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const version = String(ns.args[1] || "unknown");

    if (version !== VERSION) {
        ns.print(`Stale share drone refusing to perform. local=${VERSION} arg=${version}`);
        return;
    }

    await ns.share();
}
