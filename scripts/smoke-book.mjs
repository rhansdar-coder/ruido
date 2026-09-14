#!/usr/bin/env node
// The book, over the real HTTP surface, with a real provider in it.
//
//   npm run verify:book
//
// ## Why this exists next to tests/orderbook.test.mjs
//
// That file tests the rules: what an offer is, what it refuses, how it ranks.
// It never opens a socket, so it cannot see the thing this process actually
// does — go and fetch a provider's terms and build the row itself. That is the
// design, and a design nothing exercises is a design that quietly becomes a
// comment. So this script starts a real provider, registers it, queries the
// book, and compares what came back against the provider's own `/terms`.
//
// ## The two things it checks that no unit test can
//
//   1. **The row matches the provider.** The book is not told a price; it reads
//      one. If the two ever disagree, the book is quoting something the provider
//      would refuse.
//   2. **A provider publishing a secret loses its listing.** The unit test
//      proves `validateOffer` throws. This proves the process refuses to accept
//      the registration — and, on refresh, withdraws a row that has gone bad.

import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { quote } from "../src/quote.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;

const ADDRESS = "0x0119f9a1e4e3f0f0c2a1b8d7e6f5a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d";
const CELL = 1.93;

let failures = 0;
const ok = (label, detail = "") => console.log(`  \x1b[32mok\x1b[0m   ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
const bad = (label, detail = "") => {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
};
const check = (condition, label, detail = "") => (condition ? ok(label, detail) : bad(label, detail));
const rule = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Starts a server process and waits until it answers on `path`. */
async function start(script, port, args = [], path = "/terms") {
  const child = spawn(NODE, [join(ROOT, script), "--port", String(port), ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${script} exited before it listened:\n${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      if (response.ok) return { child, url: `http://127.0.0.1:${port}`, log: () => log };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`${script} never answered on ${port}:\n${log}`);
}

const post = (url, path, body) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A fake provider that serves whatever terms it is told to. */
async function fakeProvider(terms) {
  const port = await freePort();
  const server = createHttpServer((_request, response) => {
    const payload = JSON.stringify(terms);
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${port}` };
}

const children = [];
const sockets = [];

try {
  const bookPort = await freePort();
  const book = await start("scripts/serve-book.mjs", bookPort, [], "/health");
  children.push(book.child);

  // --- an empty book ----------------------------------------------------------

  rule("A book with nothing in it");

  {
    const health = await (await fetch(`${book.url}/health`)).json();
    check(health.ok === true && health.offers === 0, "it starts empty", `${health.offers} offers`);

    const empty = await (await fetch(`${book.url}/offers?network=sepolia&bits=3`)).json();
    check(empty.candidates.length === 0, "and ranks nothing");
    check(empty.excluded.length === 0, "with no exclusions either, because there was nothing to exclude");
  }

  // --- a real provider registers itself ---------------------------------------

  rule("A real provider registers by endpoint");

  const providerPort = await freePort();
  const provider = await start(
    "scripts/serve-provider.mjs",
    providerPort,
    ["--address", ADDRESS, "--at", "14865236"],
  );
  children.push(provider.child);

  // `GET /terms` answers with a document: the numbers under `terms`, the routes
  // and the height policy beside them. The comparisons below are against the
  // pricing half, so it is unwrapped once, here.
  const published = await (await fetch(`${provider.url}/terms`)).json();
  const terms = published.terms ?? published;

  {
    const response = await post(book.url, "/offers", { endpoint: provider.url });
    const body = await response.json();
    check(response.status === 201, "the registration is created", `HTTP ${response.status}`);
    check(body.offer.endpoint === provider.url, "the row is the endpoint that was registered");
    check(
      body.offer.feePerCall === String(terms.feePerCall),
      "the row's fee is the provider's own, not one the book was told",
      `${body.offer.feePerCall} vs ${terms.feePerCall}`,
    );
    check(body.offer.ladder === terms.ladder, "and its ladder", `${body.offer.ladder}`);
    check(body.offer.address === ADDRESS, "and the address it can be paid at");
    check(body.offer.payable === true, "so it is marked payable");
    check(body.offer.reachable === true, "and reachable, because the book just read its terms");
    check(Array.isArray(body.unverified) && body.unverified.includes("reachable"), "and the hearsay is labelled", body.unverified.join(","));
  }

  {
    const again = await post(book.url, "/offers", { endpoint: `${provider.url}/` });
    const body = await again.json();
    check(again.status === 200, "registering the same endpoint again is not a new row", `HTTP ${again.status}`);
    check(body.replaced === true, "it says it replaced rather than created");
    const health = await (await fetch(`${book.url}/health`)).json();
    check(health.offers === 1, "and the book still holds one row", String(health.offers));
  }

  // --- the book's price is the provider's price -------------------------------

  rule("The book quotes what the provider would charge");

  {
    const listed = await (await fetch(`${book.url}/offers?network=sepolia&bits=3&mode=window&cell=${CELL}`)).json();
    check(listed.candidates.length === 1, "the provider is a candidate", String(listed.candidates.length));

    const candidate = listed.candidates[0];
    const mine = quote({ targetCell: CELL, bits: 3, mode: "window", network: "sepolia", ladder: terms.ladder });
    check(candidate.decoys === mine.decoys, "the decoy count matches a quote computed from the provider's terms", `${candidate.decoys} vs ${mine.decoys}`);
    check(
      BigInt(candidate.cost) === mine.cost,
      "and so does the cost",
      `${candidate.cost} vs ${mine.cost}`,
    );
    check(candidate.endpoint === provider.url, "and the endpoint to talk to is the provider's own");
  }

  {
    // Aimed is cheaper than window-only at the same bits, because the ladder is
    // out of the picture. If the book were quoting one figure for both, this is
    // the check that would fail.
    const aimed = await (await fetch(`${book.url}/offers?network=sepolia&bits=3&mode=aimed&cell=${CELL}`)).json();
    const windowOnly = await (await fetch(`${book.url}/offers?network=sepolia&bits=3&mode=window&cell=${CELL}`)).json();
    check(
      BigInt(aimed.candidates[0].cost) < BigInt(windowOnly.candidates[0].cost),
      "aimed and window-only are priced differently, from the same row",
      `${aimed.candidates[0].cost} vs ${windowOnly.candidates[0].cost}`,
    );
  }

  {
    const mainnet = await (await fetch(`${book.url}/offers?network=mainnet&bits=3&cell=${CELL}`)).json();
    check(mainnet.candidates.length === 0, "a query for another network finds nothing");
    check(/serves sepolia/.test(mainnet.excluded[0]?.why ?? ""), "and says which network the provider serves", mainnet.excluded[0]?.why ?? "—");
  }

  // --- what the book admits it learns -----------------------------------------

  rule("What the query tells the book");

  {
    const listed = await (await fetch(`${book.url}/offers?network=sepolia&bits=3&mode=window&cell=${CELL}`)).json();
    check(listed.privacy?.learned?.bits === 3, "the size is named as learned");
    check(listed.privacy?.learned?.network === "sepolia", "and so is the network");
    check(listed.privacy?.notLearned?.includes("window"), "the window is named as NOT learned");
    check(/no parameter for it/.test(listed.privacy?.note ?? ""), "and the note says why it cannot be");
    check(typeof listed.asOf === "string", "the answer carries how fresh it is", listed.asOf);

    const keys = Object.keys(listed).map((k) => k.toLowerCase());
    check(!keys.includes("window"), "no window appears in the response");
    check(!JSON.stringify(listed.candidates).includes('"window"'), "and none in a candidate");
  }

  {
    const browse = await (await fetch(`${book.url}/offers?network=sepolia`)).json();
    check(Array.isArray(browse.offers) && browse.offers.length === 1, "browsing without a size lists the book unranked");
    check(browse.candidates === undefined, "and does not invent a size to rank by");
    check(browse.offers[0].unverified?.includes("reachable"), "each row says what is hearsay");
  }

  // --- the projection, which is the defence that does the work ----------------

  rule("A provider's terms are projected, not republished");

  {
    // The provider answers perfectly well and its terms carry a buyer's
    // denomination, a window salt, and the request it was sent — which is how
    // this would really arrive. The book lists it anyway, because the row is a
    // fixed projection: a field the book does not read is a field it cannot
    // republish. That is stronger than a refusal, and it is why the refusal
    // below is not the only thing standing here.
    const noisy = await fakeProvider({
      ...terms,
      denomination: "10",
      windowSalt: "0xdead",
      lastRequest: { order: { window: { from: 1, to: 2 } } },
    });
    sockets.push(noisy.server);

    const response = await post(book.url, "/offers", { endpoint: noisy.url });
    const body = await response.json();
    check(response.status === 201, "a provider whose terms carry junk is still listed", `HTTP ${response.status}`);

    const flat = JSON.stringify(body.offer);
    const leaked = ["denomination", "windowSalt", "0xdead", "lastRequest", '"window"'].filter((s) => flat.includes(s));
    check(leaked.length === 0, "and none of the junk reached the row", leaked.join(",") || "clean");

    // The row still prices, which is the point: the junk was dropped, not the
    // provider. A book that refused this would be refusing a provider for
    // publishing something the book never reads.
    const priced = await (await fetch(`${book.url}/offers?network=sepolia&bits=3&cell=${CELL}`)).json();
    check(priced.candidates.length === 2, "and it is a candidate like any other", String(priced.candidates.length));
  }

  // --- the doors --------------------------------------------------------------

  rule("Registrations the book refuses");

  {
    const noEndpoint = await post(book.url, "/offers", {});
    const body = await noEndpoint.json();
    check(noEndpoint.status === 400, "a registration with no endpoint is refused", `HTTP ${noEndpoint.status}`);
    check(/reads the terms from the provider/.test(body.error ?? ""), "and says the book reads the terms itself");
  }

  {
    const dead = await freePort();
    const gone = await post(book.url, "/offers", { endpoint: `http://127.0.0.1:${dead}` });
    const body = await gone.json();
    check(gone.status === 502, "a provider that does not answer is a 502, not a 400", `HTTP ${gone.status}`);
    check(/could not read the terms/.test(body.error ?? ""), "and the book says whose problem it is");
    const health = await (await fetch(`${book.url}/health`)).json();
    check(health.offers === 2, "nothing was added by the failed registration", String(health.offers));
  }

  {
    // The one place the projection does NOT reach: `claimed` is the provider's
    // own words, carried whole so that a page can label them. So the refusal has
    // to do the work here, and it has to name the field.
    const leaky = await fakeProvider({ ...terms, claimed: { ordersServed: 4, noteId: "0xabc" } });
    sockets.push(leaky.server);
    const response = await post(book.url, "/offers", { endpoint: leaky.url });
    const body = await response.json();
    check(response.status === 400, "a secret in the provider's own claims is refused", `HTTP ${response.status}`);
    check(/will not list/.test(body.error ?? ""), "and the refusal is about the terms, not the connection");
    check(/claimed\.noteId/.test(body.reason ?? ""), "and it names the full path", body.reason ?? "—");
    const health = await (await fetch(`${book.url}/health`)).json();
    check(health.offers === 2, "the book is unchanged", String(health.offers));
  }

  {
    // Nested one level deeper, which is where a real echo would put it.
    const nested = await fakeProvider({ ...terms, claimed: { lastOrder: { window: { from: 1, to: 2 } } } });
    sockets.push(nested.server);
    const response = await post(book.url, "/offers", { endpoint: nested.url });
    const body = await response.json();
    check(response.status === 400, "a nested secret is refused too", `HTTP ${response.status}`);
    check(/claimed\.lastOrder\.window/.test(body.reason ?? ""), "with the full path named", body.reason ?? "—");
  }

  // --- a row that goes bad ----------------------------------------------------

  rule("A provider that starts leaking after it is listed");

  {
    // The path a provider would actually take to sneak something in: pass the
    // door clean, then change what it publishes. The book is started with
    // `--ttl 0`, so every read re-fetches — which is what makes the refresh path
    // reachable from a test instead of a matter of waiting thirty seconds.
    let current = { ...terms, claimed: { ordersServed: 4 } };
    const port = await freePort();
    const server = createHttpServer((_request, response) => {
      const payload = JSON.stringify(current);
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      response.end(payload);
    });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    sockets.push(server);
    const endpoint = `http://127.0.0.1:${port}`;

    const watchfulPort = await freePort();
    const watchful = await start("scripts/serve-book.mjs", watchfulPort, ["--ttl", "0"], "/health");
    children.push(watchful.child);

    const registered = await post(watchful.url, "/offers", { endpoint });
    check(registered.status === 201, "it is listed while it is clean", `HTTP ${registered.status}`);

    const listed = await (await fetch(`${watchful.url}/offers?network=sepolia&bits=3&cell=${CELL}`)).json();
    check(listed.candidates.length === 1, "and it prices", String(listed.candidates.length));

    // Now it starts publishing a note id under its own claims.
    current = { ...terms, claimed: { ordersServed: 4, noteId: "0xabc" } };

    const after = await (await fetch(`${watchful.url}/offers?network=sepolia&bits=3&cell=${CELL}`)).json();
    check(after.candidates.length === 0, "once it leaks, it is gone from the listing", String(after.candidates.length));
    const health = await (await fetch(`${watchful.url}/health`)).json();
    check(health.offers === 0, "the row was withdrawn, not merely hidden", String(health.offers));
  }

  // --- a book that outlives a process -----------------------------------------

  rule("Export and import");

  {
    const text = await (await fetch(`${book.url}/export`)).text();
    check(/"feePerCall"/.test(text), "the export is JSON", text.slice(0, 40));

    // Derived from the book itself rather than written down, so adding a phase
    // above cannot leave this comparing against a number that used to be right.
    const before = await (await fetch(`${book.url}/health`)).json();

    const otherPort = await freePort();
    const other = await start("scripts/serve-book.mjs", otherPort, [], "/health");
    children.push(other.child);

    const response = await fetch(`${other.url}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
    const body = await response.json();
    check(
      response.status === 200 && body.imported === before.offers,
      "a book can be moved to another host",
      `imported ${body.imported} of ${before.offers}`,
    );

    const listed = await (await fetch(`${other.url}/offers?network=sepolia&bits=3&cell=${CELL}`)).json();
    check(listed.candidates.length === before.offers, "and every row still prices", `${listed.candidates.length} of ${before.offers}`);

    // A hand-edited file is the threat this guards: `parseBook` re-validates
    // every row, so a secret cannot be smuggled in through the side door after
    // the registration door refused it.
    const rows = JSON.parse(text).offers;
    const tampered = JSON.stringify([{ ...rows[0], denomination: "10" }]);
    const rejected = await fetch(`${other.url}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: tampered,
    });
    const reason = await rejected.json();
    check(rejected.status === 400, "an imported book is validated, so a hand-edited one cannot smuggle a secret", `HTTP ${rejected.status}`);
    check(/denomination/.test(reason.reason ?? ""), "and the refusal names the field", reason.reason ?? "—");
    const unchanged = await (await fetch(`${other.url}/health`)).json();
    check(unchanged.offers === before.offers, "and the refused file changed nothing", String(unchanged.offers));
  }

  // --- the book answers the question a buyer has ------------------------------

  rule("A buyer can find a provider without telling anyone their window");

  {
    const listed = await (await fetch(`${book.url}/offers?network=sepolia&bits=3&mode=window&cell=${CELL}`)).json();
    const best = listed.candidates[0];
    check(best !== undefined, "there is a provider to talk to");
    check(/^http:\/\/127\.0\.0\.1:\d+$/.test(best.endpoint ?? ""), "and the buyer is given its endpoint", best.endpoint ?? "—");

    // The next step is `npm run buy --provider <that endpoint>`, which is where
    // the window goes — to the provider, and nowhere else.
    const again = await (await fetch(`${best.endpoint}/terms`)).json();
    check((again.terms ?? again).network === "sepolia", "the endpoint the book handed over is a provider that answers");
  }

  // --- the coordination fee, reachable from the processes ---------------------

  rule("A provider can declare a fee, and the book checks it against its own rate");

  {
    // The REAL provider, started the way an operator would start it. A fixture
    // would agree with the book by construction; what is checked here is that
    // the flag reaches the published terms at all — which is the gap this closes,
    // because before it `providerTerms` could not carry a fee and the whole
    // mechanism was unreachable from a running process.
    const fee = await start(
      "scripts/serve-provider.mjs",
      await freePort(),
      ["--coordination-bps", "500", "--coordination-address", ADDRESS],
      "/terms",
    );
    children.push(fee.child);

    const published = await (await fetch(`${fee.url}/terms`)).json();
    const declared = (published.terms ?? published).coordination;
    check(declared?.bps === 500, "a provider started with --coordination-bps publishes the rate", JSON.stringify(declared));
    check(declared?.address === ADDRESS, "and the address the fee is forwarded to");

    // The book takes its rate from its own configuration and checks every row
    // against it. Same rate: listed, and the fee is disclosed on the row.
    const agreeing = await start("scripts/serve-book.mjs", await freePort(), ["--coordination-bps", "500"], "/health");
    children.push(agreeing.child);

    const response = await post(agreeing.url, "/offers", { endpoint: fee.url });
    const body = await response.json();
    check(response.status === 201, "a book charging the same rate lists it", `HTTP ${response.status}`);
    check(body.offer?.coordination?.charged === true, "and the row discloses the fee", JSON.stringify(body.offer?.coordination));
    check(
      body.unverified?.includes("coordination"),
      "and labels it hearsay, because the book cannot see the forwarding",
      body.unverified?.join(",") ?? "—",
    );

    const health = await (await fetch(`${agreeing.url}/health`)).json();
    check(health.coordinationBps === 500, "and the book reports the rate it checks against", String(health.coordinationBps));

    // A book left at zero is the misconfiguration this catches. It would refuse
    // every honest row, and without the named refusal the operator would see an
    // empty book and go looking in the wrong place.
    const mismatched = await start("scripts/serve-book.mjs", await freePort(), [], "/health");
    children.push(mismatched.child);

    const refused = await post(mismatched.url, "/offers", { endpoint: fee.url });
    const why = await refused.json();
    check(refused.status === 400, "a book charging nothing refuses the same row", `HTTP ${refused.status}`);
    check(/the rate is the protocol's/.test(why.reason ?? ""), "and the refusal says whose rate it is", why.reason ?? "—");
    check(/\b500\b/.test(why.reason ?? "") && /\b0\b/.test(why.reason ?? ""), "and names both numbers, so the mismatch is visible");
  }
} catch (error) {
  bad("the book ran at all", error.message);
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.close();
}

console.log(
  failures === 0
    ? "\n\x1b[32mA buyer can find a provider without publishing a cell.\x1b[0m  offers, not orders.\n"
    : `\n\x1b[31m${failures} check${failures === 1 ? "" : "s"} failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
