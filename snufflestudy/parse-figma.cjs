#!/usr/bin/env node
/**
 * parse-figma.js
 *
 * Flattens design-specs/raw-nodes.json (Figma REST API response) and
 * design-specs/variables.json (Figma plugin export) into:
 *   - design-specs/tokens.json          name -> { type, collection, values }
 *   - design-specs/components.json      component/component-set metadata
 *   - design-specs/frames/<slug>.json   one simplified tree per fetched node
 *
 * Run from the directory that contains design-specs/:
 *   node parse-figma.js
 */

const fs = require("fs");
const path = require("path");

const SPECS_DIR = path.join(process.cwd(), "design-specs");
const RAW_NODES_PATH = path.join(SPECS_DIR, "raw-nodes.json");
const VARIABLES_PATH = path.join(SPECS_DIR, "variables.json");
const FRAMES_DIR = path.join(SPECS_DIR, "frames");

function loadJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`Missing ${label}: ${filePath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function slugify(name, fallback) {
  const slug = (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function rgbaToHex(color) {
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  const hex = `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  return color.a < 1 ? `${hex}${toHex(color.a)}` : hex;
}

function parseVariantName(name) {
  const props = {};
  (name || "").split(",").forEach((pair) => {
    const [k, v] = pair.split("=").map((s) => s && s.trim());
    if (k && v) props[k] = v;
  });
  return props;
}

// ---- Load input ----
const rawNodes = loadJson(RAW_NODES_PATH, "raw-nodes.json");
const rawVariables = loadJson(VARIABLES_PATH, "variables.json");

if (rawNodes.err) {
  console.error(`raw-nodes.json contains an API error: ${rawNodes.err}`);
  process.exit(1);
}

// ---- Build token lookups ----
const tokensById = new Map(); // variable id -> token info, used to resolve boundVariables
const tokensByName = {}; // variable name -> token info, written to tokens.json
let missingIdWarned = false;

for (const collection of rawVariables) {
  for (const variable of collection.variables) {
    if (!variable.id && !missingIdWarned) {
      console.warn(
        "Warning: variables.json has no variable ids. Re-run the updated " +
          "plugin and re-export before bound-variable references (padding, " +
          "gap, colors tied to a variable) will resolve to token names."
      );
      missingIdWarned = true;
    }
    const token = {
      type: variable.type,
      collection: collection.collection,
      values: variable.values,
    };
    if (variable.id) tokensById.set(variable.id, { name: variable.name, ...token });
    tokensByName[variable.name] = token;
  }
}

function resolveScalar(rawValue, boundVar) {
  if (boundVar && boundVar.id) {
    const token = tokensById.get(boundVar.id);
    if (token) return { token: token.name, values: token.values };
  }
  return rawValue;
}

function resolveFills(fills) {
  if (!fills) return undefined;
  return fills
    .filter((f) => f.visible !== false)
    .map((f) => {
      if (f.type === "SOLID") {
        const boundColor = f.boundVariables && f.boundVariables.color;
        if (boundColor) {
          const token = tokensById.get(boundColor.id);
          if (token) return { kind: "token", token: token.name, values: token.values };
        }
        return { kind: "color", hex: rgbaToHex(f.color) };
      }
      if (f.type === "IMAGE") {
        return { kind: "image", imageRef: f.imageRef, scaleMode: f.scaleMode };
      }
      return { kind: f.type };
    });
}

// ---- Simplify one node (recursive) ----
function simplifyNode(node) {
  const bv = node.boundVariables || {};
  const simplified = { id: node.id, name: node.name, type: node.type };

  if (typeof node.opacity === "number" && node.opacity !== 1) {
    simplified.opacity = node.opacity;
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    simplified.layout = {
      direction: node.layoutMode,
      gap: resolveScalar(node.itemSpacing, bv.itemSpacing),
      padding: {
        top: resolveScalar(node.paddingTop, bv.paddingTop),
        right: resolveScalar(node.paddingRight, bv.paddingRight),
        bottom: resolveScalar(node.paddingBottom, bv.paddingBottom),
        left: resolveScalar(node.paddingLeft, bv.paddingLeft),
      },
      primaryAxisAlign: node.primaryAxisAlignItems,
      counterAxisAlign: node.counterAxisAlignItems,
      sizing: {
        primary: node.primaryAxisSizingMode,
        counter: node.counterAxisSizingMode,
      },
    };
  }

  const fills = resolveFills(node.fills);
  if (fills && fills.length) simplified.fills = fills;

  if (node.cornerRadius !== undefined) {
    simplified.cornerRadius = resolveScalar(node.cornerRadius, bv.cornerRadius);
  }

  if (node.type === "TEXT") {
    simplified.text = node.characters;
    if (node.style) {
      simplified.textStyle = {
        fontFamily: node.style.fontFamily,
        fontSize: node.style.fontSize,
        fontWeight: node.style.fontWeight,
        lineHeight: node.style.lineHeightPx,
        letterSpacing: node.style.letterSpacing,
        align: node.style.textAlignHorizontal,
      };
    }
  }

  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    simplified.variantProps = parseVariantName(node.name);
  }

  if (node.type === "INSTANCE") {
    simplified.componentId = node.componentId;
    if (node.componentProperties) {
      simplified.componentProperties = node.componentProperties;
    }
  }

  if (node.reactions && node.reactions.length) {
    simplified.interactions = node.reactions.map((r) => ({
      trigger: r.trigger && r.trigger.type,
      actions: (r.actions || [r.action]).filter(Boolean).map((a) => ({
        type: a.type,
        destinationId: a.destinationId,
        navigation: a.navigation,
        transition: a.transition && a.transition.type,
      })),
    }));
  }

  if (Array.isArray(node.children) && node.children.length) {
    simplified.children = node.children.map(simplifyNode);
  }

  return simplified;
}

// ---- Process every fetched top-level node ----
fs.mkdirSync(FRAMES_DIR, { recursive: true });

const componentsById = {};
const componentSetsById = {};
const usedSlugs = new Set();
let frameCount = 0;

for (const [nodeId, entry] of Object.entries(rawNodes.nodes)) {
  if (!entry || !entry.document) continue;

  Object.assign(componentsById, entry.components || {});
  Object.assign(componentSetsById, entry.componentSets || {});

  const simplified = simplifyNode(entry.document);

  let slug = slugify(entry.document.name, nodeId.replace(":", "-"));
  if (usedSlugs.has(slug)) slug = `${slug}-${nodeId.replace(":", "-")}`;
  usedSlugs.add(slug);

  fs.writeFileSync(
    path.join(FRAMES_DIR, `${slug}.json`),
    JSON.stringify(simplified, null, 2)
  );
  frameCount += 1;
}

// ---- Write tokens.json and components.json ----
fs.writeFileSync(path.join(SPECS_DIR, "tokens.json"), JSON.stringify(tokensByName, null, 2));

fs.writeFileSync(
  path.join(SPECS_DIR, "components.json"),
  JSON.stringify({ components: componentsById, componentSets: componentSetsById }, null, 2)
);

console.log(`Wrote ${frameCount} frame file(s) to ${FRAMES_DIR}`);
console.log(`Wrote ${Object.keys(tokensByName).length} token(s) to design-specs/tokens.json`);
console.log(
  `Wrote ${Object.keys(componentsById).length} component(s) and ` +
    `${Object.keys(componentSetsById).length} component set(s) to design-specs/components.json`
);
