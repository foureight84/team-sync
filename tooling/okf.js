import matter from "gray-matter";

/**
 * Open Knowledge Format (OKF) helpers.
 *
 * An OKF event is plain Markdown with strict YAML frontmatter. This module is
 * the single place that knows the schema, so both the publisher and the daemon
 * agree on what a valid event looks like.
 */

export const OKF_TYPE = "log_event";

/** Required frontmatter keys for a `log_event`. */
const REQUIRED_FIELDS = [
  "type",
  "title",
  "author",
  "timestamp",
  "impacted_files",
  "breaking",
];

/**
 * Parse a raw OKF markdown string into `{ data, body }`.
 * Throws if the frontmatter cannot be read.
 */
export function parseOkf(raw) {
  const { data, content } = matter(raw);
  return { data, body: content.trim() };
}

/**
 * Validate parsed OKF frontmatter. Returns an array of human-readable problems;
 * an empty array means the event is valid.
 */
export function validateOkf(data) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null || data[field] === "") {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (data.type && data.type !== OKF_TYPE) {
    errors.push(`type must be "${OKF_TYPE}", got "${data.type}"`);
  }

  if (data.impacted_files !== undefined && !Array.isArray(data.impacted_files)) {
    errors.push("impacted_files must be a list");
  }

  if (data.breaking !== undefined && typeof data.breaking !== "boolean") {
    errors.push("breaking must be a boolean (true/false)");
  }

  if (data.timestamp !== undefined && Number.isNaN(Date.parse(data.timestamp))) {
    errors.push(`timestamp is not a valid ISO-8601 date: ${data.timestamp}`);
  }

  return errors;
}

/**
 * Build an OKF markdown document from structured fields. Used by tooling/tests;
 * agents normally author the markdown directly per AGENTS.md.
 */
export function buildOkf({
  title,
  author,
  timestamp,
  impactedFiles = [],
  breaking = false,
  summary = [],
  downstream = [],
}) {
  const frontmatter = {
    type: OKF_TYPE,
    title,
    author,
    timestamp,
    impacted_files: impactedFiles,
    breaking,
  };

  const body = [
    "### Summary of Changes",
    ...summary.map((line) => `- ${line}`),
    "",
    "### Downstream Impact for Parallel Agents",
    ...downstream.map((line) => `- ${line}`),
  ].join("\n");

  return matter.stringify(`\n${body}\n`, frontmatter);
}

/**
 * Derive a filesystem-safe slug from an OKF title for use in log filenames.
 */
export function slugify(title = "event") {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "event";
}
