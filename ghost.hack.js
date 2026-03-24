import { VERSION } from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const target = String(ns.args[0] || "");
    const version = String(ns.args[1] || "unknown");

    if (!target) {
        ns.tprint("ghost.hack.js needs a target.");
        return;
    }

    if (version !== VERSION) {
        ns.print(`Stale hack drone refusing to perform. local=${VERSION} arg=${version}`);
        return;
    }

    await ns.hack(target);
}