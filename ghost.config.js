export const VERSION = "1.0.7";

export const WORKER_SCRIPTS = [
    "ghost.hack.js",
    "ghost.grow.js",
    "ghost.share.js",
    "ghost.weaken.js",
];

export const ALL_SCRIPTS = [
    "ghost.config.js",
    "ghost.controller.js",
    "ghost.report.js",
    ...WORKER_SCRIPTS,
];

export const DECOMMISSION_FILE = "ghost.decommission.txt";
export const SHARE_ENABLE_FILE = "ghost.share.enabled.txt";

export const RESERVED_HOME_RAM = 32;

export const SECURITY_BUFFER = 5;
export const MONEY_THRESHOLD = 0.90;
export const HACK_MONEY_FRACTION = 0.10;

export const CONTROLLER_INTERVAL = 15000;
