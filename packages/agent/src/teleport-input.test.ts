import { test } from "node:test";
import assert from "node:assert/strict";
import { TeleportBodySchema } from "./teleport-input.js";

// PalDefender UserIds are "<platform>_<id>". Mac clients get "mac_A:_<hash>", which contains a colon.
const IDS = ["steam_76561198000000000", "xbox_2535400000000000", "mac_A:_ea0ee499ee8782eded4a611a92d63781"];

test("TeleportBodySchema: Steam, Xbox and Mac UserIds are accepted as source and as target", () => {
  for (const id of IDS) {
    assert.deepEqual(TeleportBodySchema.parse({ source: id, target: id }), { source: id, target: id });
  }
});

test("TeleportBodySchema: coordinate targets are accepted", () => {
  for (const target of ["137.72 -446.52", "-553 -1332", "440 679 1500.5"]) {
    assert.equal(TeleportBodySchema.parse({ source: IDS[2], target }).target, target);
  }
});

test("TeleportBodySchema: anything that could split or extend an RCON command is rejected", () => {
  for (const bad of ["", "a b", "a;b", "a\nb", "a\rb", "a/b", "a\"b", "$(x)"]) {
    assert.equal(TeleportBodySchema.safeParse({ source: bad, target: "1 2" }).success, false, `source ${JSON.stringify(bad)}`);
  }
  for (const bad of ["", ";", "1 2\ntp x y", "a|b", "`x`", "a\"b"]) {
    assert.equal(TeleportBodySchema.safeParse({ source: IDS[0], target: bad }).success, false, `target ${JSON.stringify(bad)}`);
  }
});

test("TeleportBodySchema: over-long ids are rejected", () => {
  assert.equal(TeleportBodySchema.safeParse({ source: "a".repeat(129), target: "1 2" }).success, false);
  assert.equal(TeleportBodySchema.safeParse({ source: IDS[0], target: "1".repeat(129) }).success, false);
});
