// The in-app author help. Every pre-flight finding, every wizard step, and both
// author-facing tabs link into a topic here, so a non-coder never hits a dead end
// that says only "forbidden API" and stops.
//
// These are written for someone whose AI agent is doing the actual coding: they
// explain what went wrong, why the platform works that way, and what to tell the
// agent to change. Prose, not error codes.

export type HelpTopic =
  | "getting-started"
  | "bundle"
  | "network"
  | "storage"
  | "eval"
  | "host-access"
  | "permissions"
  | "manifest"
  | "versions"
  | "review"
  | "rejected"
  | "yank";

export interface HelpSection {
  heading?: string;
  /** Paragraphs of plain prose. */
  body?: string[];
  /** Bulleted points, rendered tighter than prose. */
  bullets?: string[];
  /** A short code or config sample. */
  code?: string;
}

export interface HelpArticle {
  id: HelpTopic;
  title: string;
  /** One-line summary, used in the topic list. */
  summary: string;
  sections: HelpSection[];
}

export const HELP_ARTICLES: Record<HelpTopic, HelpArticle> = {
  "getting-started": {
    id: "getting-started",
    title: "What a plugin is",
    summary: "A self-contained web app that runs inside Helios.",
    sections: [
      {
        body: [
          "A plugin is a small, self-contained web app — a calculator, a simulation front end, a data viewer — that runs inside Helios and appears in the Marketplace for anyone on the team to install.",
          "You do not need to know how to code to publish one. Most authors describe what they want to an AI coding agent, which writes it against the Helios plugin SDK. What you do need to understand is the one rule below, because it is the rule agents most often get wrong.",
        ],
      },
      {
        heading: "The rule that matters most",
        body: [
          "A plugin runs in a locked-down sandbox with no network access, no access to Helios itself, and no browser storage. Everything it needs must be inside the bundle, and everything it wants from the outside world goes through the SDK.",
          "This is not a restriction anyone can lift for you. It is enforced by the browser engine, so a plugin that assumes otherwise does not fail loudly — it silently does nothing. That is why the checks in this wizard exist: they catch those assumptions before you ship them.",
        ],
      },
      {
        heading: "The shape of the work",
        bullets: [
          "Start a new plugin — Helios writes a starter project and the full authoring kit into a folder you choose.",
          "Hand the copy-paste prompt to your AI agent. It reads the kit from that folder.",
          "When the agent has produced a build in dist/, come back and click Add to Marketplace.",
          "Your subteam lead or VP reviews it. Once approved, anyone on the team can install it.",
        ],
      },
    ],
  },

  bundle: {
    id: "bundle",
    title: "What ships in a bundle",
    summary: "manifest.json plus your built dist/ folder — nothing else.",
    sections: [
      {
        body: [
          "Helios packs two things: your manifest.json, and the built output folder that manifest.entry points into (normally dist/). Source files, node_modules, and .git are deliberately left out — a bundle is the built artifact, not the project.",
          "That means you must run your build before publishing. If your agent has written source but not built it, dist/ will be missing or stale, and the wizard will tell you so.",
        ],
      },
      {
        heading: "Everything must be self-contained",
        body: [
          "The entry HTML has to work with no network. Scripts, styles, fonts, and images must be inlined or referenced by relative paths inside the bundle. A CDN link, a Google Font, or a remote image will simply not load.",
        ],
        bullets: [
          "Images go in as data: URIs or files inside dist/.",
          "No <script src=\"https://...\">, no remote stylesheets, no web fonts from a URL.",
          "Bundle your framework in rather than loading it from a CDN.",
        ],
      },
      {
        heading: "Size",
        body: [
          "A bundle is capped at 25 MB. If you are over, it is almost always a large asset that could be compressed or left out — the wizard names the biggest files for you.",
        ],
      },
    ],
  },

  network: {
    id: "network",
    title: "There is no network",
    summary: "fetch, XHR, WebSocket, and sendBeacon are all blocked.",
    sections: [
      {
        body: [
          "A plugin cannot make network calls. fetch(), XMLHttpRequest, WebSocket, and navigator.sendBeacon are blocked by the sandbox's content-security policy, and no permission turns them on.",
          "This is the wall that makes it safe to run a teammate's code on everyone's machine: whatever a plugin computes, it cannot send anywhere, and it cannot pull code in from outside.",
        ],
      },
      {
        heading: "What to do instead",
        bullets: [
          "Need data from a file? Ask the SDK to show the user a file picker — openFile() with the file.read permission. The user chooses what to hand over.",
          "Need to give the user a result? save() with the file.write permission opens a save dialog.",
          "Need to remember something between sessions? The SDK storage API with the storage permission.",
          "Need reference data? Bundle it in as a JSON or CSV file inside dist/.",
        ],
      },
      {
        heading: "Tell your agent",
        code: "Remove every fetch/XHR/WebSocket call. This plugin has no network.\nUse the @helios/plugin-sdk file and storage APIs, or bundle the data\ninto dist/ as a static file imported at build time.",
      },
    ],
  },

  storage: {
    id: "storage",
    title: "Browser storage is unavailable",
    summary: "Use the SDK storage API instead of localStorage.",
    sections: [
      {
        body: [
          "localStorage, sessionStorage, indexedDB, and document.cookie do not work in the plugin sandbox. The plugin runs at an opaque origin, so the browser refuses them outright — code that uses them throws or silently does nothing.",
          "The SDK provides a replacement that does work: a private key-value store, isolated per plugin, that persists between sessions. It requires the storage permission in your manifest.",
        ],
      },
      {
        heading: "The replacement",
        code: "import { storage } from \"@helios/plugin-sdk\";\n\nawait storage.set(\"inputs\", { mass: 250, cd: 1.2 });\nconst last = await storage.get(\"inputs\");",
      },
      {
        heading: "Tell your agent",
        code: "Replace every localStorage/sessionStorage/indexedDB use with the\n@helios/plugin-sdk storage API, and add \"storage\" to the permissions\narray in manifest.json.",
      },
    ],
  },

  eval: {
    id: "eval",
    title: "No dynamic code execution",
    summary: "eval() and its relatives are blocked.",
    sections: [
      {
        body: [
          "eval(), new Function(), and similar dynamic-code paths are blocked by the sandbox policy. This is rarely deliberate — it usually arrives through a bundler setting or an older library that builds code strings at runtime.",
          "If a library needs eval to work, it cannot be used in a plugin. Ask your agent for an alternative, or for a build configuration that does not emit dynamic code.",
        ],
      },
    ],
  },

  "host-access": {
    id: "host-access",
    title: "The host is out of reach",
    summary: "No window.parent, no Helios data, no login token.",
    sections: [
      {
        body: [
          "A plugin cannot touch the Helios page around it. window.parent, window.top, the Supabase client, and your login token are all unreachable — the sandbox is a separate origin specifically so that they are.",
          "Everything a plugin is allowed to ask the host for goes through the SDK, which the host re-checks against your declared permissions before it acts. That check is the door; the wall does not move.",
        ],
      },
    ],
  },

  permissions: {
    id: "permissions",
    title: "Permissions",
    summary: "Declare every capability you use, and nothing more.",
    sections: [
      {
        body: [
          "Permissions are default-deny. An empty array means a pure sandbox: your plugin renders and computes, and that is all. Every capability beyond that must be listed in manifest.json, and calling one you did not declare fails at runtime.",
          "Ask for the fewest you can. Every permission is shown to each person before they install, and a plugin that asks for less gets adopted faster.",
        ],
      },
      {
        heading: "What each one grants",
        bullets: [
          "file.read — show the user a file picker and receive the bytes of what they choose. You never see a directory listing, only the file they hand over.",
          "file.write — open a save dialog so the user can write a result to disk. The user chooses the location.",
          "storage — a private key-value store for this plugin, isolated from every other plugin and from Helios data.",
          "engine:matlab — run a MATLAB script through the machine's local licence. High trust: it needs explicit consent at install and a careful review.",
        ],
      },
      {
        heading: "Two findings you may see",
        bullets: [
          "Undeclared: your code calls a capability that manifest.json does not list. Add it to permissions — this one blocks publishing, because the call would fail for every user.",
          "Unused: manifest.json lists a permission nothing in your code uses. Drop it. This is a warning, not a blocker, but a smaller ask is a better plugin.",
        ],
      },
    ],
  },

  manifest: {
    id: "manifest",
    title: "manifest.json",
    summary: "The contract: id, name, version, entry, sdk, permissions.",
    sections: [
      {
        code: "{\n  \"format\": 1,\n  \"id\": \"aero.downforce-calculator\",\n  \"name\": \"Downforce Calculator\",\n  \"version\": \"1.0.0\",\n  \"description\": \"Computes downforce from speed and aero coefficients.\",\n  \"icon\": \"dist/icon.png\",\n  \"entry\": \"dist/index.html\",\n  \"sdk\": \"^1.0.0\",\n  \"permissions\": []\n}",
      },
      {
        heading: "The fields that trip people up",
        bullets: [
          "id — lowercase letters and digits in dot or dash segments. It is permanent: it identifies your plugin forever, and changing it creates a different plugin.",
          "version — your plugin's own semver, unrelated to the Helios version. Bump it on every publish.",
          "entry — a relative path to the HTML file inside your bundle, normally dist/index.html. It must actually exist in the folder you pick.",
          "sdk — the SDK range you built against, normally ^1.0.0.",
          "permissions — an array. Use [] if your plugin only renders and computes.",
        ],
      },
    ],
  },

  versions: {
    id: "versions",
    title: "Versions never change",
    summary: "Publishing 1.2.0 twice is impossible by design.",
    sections: [
      {
        body: [
          "Once a version is published, its contents are frozen. You cannot replace 1.2.0 with different bytes — you publish 1.2.1 instead.",
          "This is deliberate. People install specific versions, and other work can depend on the exact numbers a plugin produced. A version that quietly changed underneath them would make results impossible to reproduce.",
        ],
      },
      {
        heading: "So when you need to fix something",
        bullets: [
          "Bump version in manifest.json and publish again.",
          "If the bad version is still pending, withdraw it from My Plugins — nothing was distributed.",
          "If it was already approved, yank it. It stops being offered to anyone new.",
        ],
      },
    ],
  },

  review: {
    id: "review",
    title: "How review works",
    summary: "A lead or VP approves before anyone can install.",
    sections: [
      {
        body: [
          "Publishing submits a version; it does not release it. A lead or VP of the owning subteam reviews it and approves or rejects. Only approved versions appear in Browse or can be installed.",
          "A reviewer sees your manifest, exactly which permissions the version asks for and how that differs from your last approved release, and a compliance scan Helios re-runs against the uploaded bundle itself. They can also install and run the pending build before deciding.",
        ],
      },
      {
        heading: "You cannot approve your own submission",
        body: [
          "Even if you are a lead or VP with review rights, you cannot approve a version you published. Approval is what lets your code run on everyone else's machine, so it takes a second person. This is not a configuration — it is enforced by the database.",
        ],
      },
      {
        heading: "Why the pre-flight matters",
        body: [
          "The check this wizard runs is the same scan the reviewer's copy runs. If it is green here, it will be green there. Fix everything the wizard flags and review becomes a question of whether the plugin is a good idea, not whether it is broken.",
        ],
      },
    ],
  },

  rejected: {
    id: "rejected",
    title: "After a rejection",
    summary: "Read the note, fix, bump the version, publish again.",
    sections: [
      {
        body: [
          "A rejected version stays in My Plugins with the reviewer's note attached. Nothing was distributed, and nothing is lost.",
          "Because versions are immutable, you do not resubmit the same number: fix the issue, bump version in manifest.json, and publish again. If the note is not clear, ask the reviewer — they are on your subteam.",
        ],
      },
      {
        heading: "The common reasons",
        bullets: [
          "A permission that is asked for but not obviously needed.",
          "A new high-trust permission appearing without explanation.",
          "The plugin does not do what its description says.",
          "It fails when the reviewer actually runs it.",
        ],
      },
    ],
  },

  yank: {
    id: "yank",
    title: "Yanking a release",
    summary: "Stops new installs. Does not uninstall anyone.",
    sections: [
      {
        body: [
          "Yanking an approved version removes it from the Marketplace: it stops being offered and can no longer be installed, and the previous approved version becomes the latest again.",
          "It does not reach out and remove the plugin from anyone who already installed it. Their copy is already unpacked on their machine and keeps working. Yank is how you stop a bad release from spreading further, not a remote kill switch.",
        ],
      },
      {
        heading: "If people must stop using it",
        body: [
          "Yank the version, publish a fixed one, and tell the team to update. Nothing in the platform forces an uninstall.",
        ],
      },
    ],
  },
};

/** Ordered topic list for the drawer's index. */
export const HELP_TOPIC_ORDER: HelpTopic[] = [
  "getting-started",
  "bundle",
  "manifest",
  "permissions",
  "network",
  "storage",
  "eval",
  "host-access",
  "versions",
  "review",
  "rejected",
  "yank",
];
