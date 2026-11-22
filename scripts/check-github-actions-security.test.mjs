import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { auditWorkflowSource } from "./check-github-actions-security.mjs";

const checkoutSha = "9f698171ed81b15d1823a05fc7211befd50c8ae0";

function workflow(
  action = `actions/checkout@${checkoutSha}`,
  checkoutOptions = "      persist-credentials: false",
) {
  return `name: Verify
on: [push]
permissions:
  contents: read
concurrency:
  group: verify
  cancel-in-progress: true
jobs:
  verify:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: ${action}
        with:
${checkoutOptions}
`;
}

test("accepts a least-privilege workflow with an immutable action", () => {
  assert.deepEqual(auditWorkflowSource(workflow()), []);
});

test("rejects mutable action tags", () => {
  assert.match(
    auditWorkflowSource(workflow("actions/checkout@v6")).join("\n"),
    /full commit SHA/,
  );
});

test("rejects pull_request_target", () => {
  assert.match(
    auditWorkflowSource(`${workflow()}\npull_request_target:\n`).join("\n"),
    /pull_request_target/,
  );
});

test("rejects missing root permissions", () => {
  assert.match(
    auditWorkflowSource(
      workflow().replace("permissions:\n  contents: read\n", ""),
    ).join("\n"),
    /permissions/,
  );
});

test("rejects checkout credential persistence", () => {
  assert.match(
    auditWorkflowSource(workflow(undefined, "      fetch-depth: 0")).join("\n"),
    /persist-credentials/,
  );
});

test("rejects write permissions outside security event upload", () => {
  assert.match(
    auditWorkflowSource(
      workflow().replace(
        "  contents: read",
        "  contents: read\n  packages: write",
      ),
    ).join("\n"),
    /packages/,
  );
});

const authMaintenanceFile = "auth-maintenance.yml";

async function authMaintenanceLines() {
  const source = await readFile(
    new URL(`../.github/workflows/${authMaintenanceFile}`, import.meta.url),
    "utf8",
  );
  return { source, lines: source.split(/\r?\n/) };
}

function rootBlock(lines, name) {
  const start = lines.indexOf(`${name}:`);
  assert.ok(start >= 0, `missing root ${name} block`);
  const end = lines.findIndex(
    (line, index) => index > start && line !== "" && !line.startsWith(" "),
  );
  return lines.slice(start + 1, end < 0 ? lines.length : end).filter(Boolean);
}

function stepBlocks(lines) {
  const starts = lines.flatMap((line, index) =>
    /^ {6}- /.test(line) ? [index] : [],
  );
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length),
  );
}

function runScripts(lines) {
  const scripts = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(\s+)run:\s*(.*)$/);
    if (!match) {
      return;
    }
    if (!/^[|>]/.test(match[2])) {
      scripts.push(match[2]);
      return;
    }
    const indent = match[1].length;
    const body = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== "" && next.search(/\S/) <= indent) {
        break;
      }
      body.push(next);
    }
    scripts.push(body.join("\n"));
  });
  return scripts;
}

test("auth maintenance workflow passes the workflow security policy", async () => {
  const { source } = await authMaintenanceLines();
  assert.deepEqual(auditWorkflowSource(source, authMaintenanceFile), []);
});

test("auth maintenance runs hourly at :17 UTC with manual dispatch and no cancellation", async () => {
  const { source, lines } = await authMaintenanceLines();

  assert.match(source, /^ {2}schedule:\r?\n {4}- cron: "17 \* \* \* \*"\r?$/m);
  assert.match(source, /^ {2}workflow_dispatch:\r?$/m);
  for (const [input, fallback, description] of [
    ["batch_size", "500", "Rows per table per batch (1..5000)"],
    ["max_batches", "10", "Maximum batches per invocation (1..100)"],
  ]) {
    const start = lines.indexOf(`      ${input}:`);
    assert.ok(start >= 0, `missing workflow_dispatch input ${input}`);
    const block = lines.slice(start + 1, start + 5);
    assert.ok(block.includes(`        description: "${description}"`));
    assert.ok(block.includes(`        default: "${fallback}"`));
    assert.ok(block.includes("        type: string"));
  }

  assert.deepEqual(rootBlock(lines, "permissions"), ["  contents: read"]);
  assert.deepEqual(rootBlock(lines, "concurrency"), [
    "  group: auth-maintenance-${{ github.workflow }}",
    "  cancel-in-progress: false",
  ]);
  assert.doesNotMatch(source, /cancel-in-progress:\s*true/);
});

test("auth maintenance exposes the direct DSN only to the purge step", async () => {
  const { source, lines } = await authMaintenanceLines();

  assert.ok(!lines.includes("env:"), "root env is forbidden");
  assert.ok(
    !lines.some((line) => /^ {4}env:/.test(line)),
    "job-level env is forbidden",
  );

  const secretSteps = stepBlocks(lines).filter((step) =>
    step.some((line) => line.includes("secrets.")),
  );
  assert.equal(secretSteps.length, 1, "exactly one step may read secrets");
  const [purgeStep] = secretSteps;
  assert.deepEqual(
    purgeStep.filter((line) => line.includes("secrets.")),
    [
      "          DATABASE_AUTH_MAINTENANCE_URL: ${{ secrets.DATABASE_AUTH_MAINTENANCE_URL }}",
    ],
  );
  assert.ok(purgeStep.includes("        env:"));
  assert.ok(
    purgeStep.some((line) =>
      line.includes("go run ./services/core-api/cmd/auth-maintenance"),
    ),
  );
  assert.equal(source.match(/secrets\./g)?.length, 1);

  // Naming the variable in an error is fine; expanding or dumping its value is not.
  for (const script of runScripts(lines)) {
    assert.doesNotMatch(
      script,
      /\b(?:echo|printf)\b[^\n]*\$\{?DATABASE_AUTH_MAINTENANCE_URL\b/,
    );
    assert.doesNotMatch(script, /\bprintenv\b/);
    assert.doesNotMatch(script, /^\s*(?:env|export\s+-p|declare\s+-p)\s*$/m);
    assert.doesNotMatch(script, /^\s*set\s+-[a-z]*x/m);
  }
});

test("auth maintenance run scripts never interpolate expressions", async () => {
  const { lines } = await authMaintenanceLines();
  const scripts = runScripts(lines);

  assert.ok(scripts.length >= 2);
  for (const script of scripts) {
    assert.doesNotMatch(script, /\$\{\{/);
  }
  const purge = scripts.find((script) => script.includes("go run"));
  assert.ok(purge);
  assert.match(purge, /set -euo pipefail/);
  assert.match(purge, /--batch-size "\$\{BATCH_SIZE\}"/);
  assert.match(purge, /--max-batches "\$\{MAX_BATCHES\}"/);
  assert.ok(
    lines.includes("          INPUT_BATCH_SIZE: ${{ inputs.batch_size }}"),
  );
  assert.ok(
    lines.includes("          INPUT_MAX_BATCHES: ${{ inputs.max_batches }}"),
  );
});

test("Core API runtime requires the patched Alpine OpenSSL release", async () => {
  const dockerfile = await readFile(
    new URL(
      "../infrastructure/huggingface/core-api/Dockerfile",
      import.meta.url,
    ),
    "utf8",
  );
  const runtimeStage = dockerfile.slice(
    dockerfile.lastIndexOf("FROM alpine:3.23"),
  );

  assert.match(runtimeStage, /apk add --no-cache --upgrade/);
  assert.match(runtimeStage, /libcrypto3>=3\.5\.8-r0/);
  assert.match(runtimeStage, /libssl3>=3\.5\.8-r0/);
  assert.ok(
    runtimeStage.indexOf("apk add --no-cache --upgrade") <
      runtimeStage.indexOf("USER tutorhub"),
    "OpenSSL packages must be upgraded before the runtime drops root privileges",
  );
});
