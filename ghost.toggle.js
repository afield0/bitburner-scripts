import {
    SHARE_ENABLE_FILE,
    SILENT_ENABLE_FILE,
    XP_ENABLE_FILE
} from "ghost.config.js";

/** @param {NS} ns **/
export async function main(ns) {
    const action = String(ns.args[0] || "status").toLowerCase();
    const feature = String(ns.args[1] || "share").toLowerCase();
    const file = getDirectiveFile(feature);

    if (!file) {
        ns.tprint(`Unknown feature '${feature}'. Use 'share', 'silent', or 'xp'.`);
        return;
    }

    if (action === "on" || action === "enable" || action === "create") {
        ns.write(file, `${feature}=on\n`, "w");
        ns.tprint(`${file} enabled.`);
        return;
    }

    if (action === "off" || action === "disable" || action === "delete" || action === "remove") {
        if (ns.fileExists(file, "home")) {
            ns.rm(file, "home");
        }
        ns.tprint(`${file} disabled.`);
        return;
    }

    if (action === "status") {
        ns.tprint(`${file} ${ns.fileExists(file, "home") ? "present" : "absent"}.`);
        return;
    }

    ns.tprint(`Usage: run ghost.toggle.js [on|off|status] [share|silent|xp]`);
}

function getDirectiveFile(feature) {
    if (feature === "share") return SHARE_ENABLE_FILE;
    if (feature === "silent") return SILENT_ENABLE_FILE;
    if (feature === "xp") return XP_ENABLE_FILE;
    return null;
}
