// ---------------------------------------------------------------------------
// M45: scripts/bot-token.mjs(ADR-030(1)(3) [2026-07-28改訂])の純粋部分
// (JWT組み立て・installation絞り込み)のテスト。実際の GitHub API 呼出しは
// モックせず対象外とする(タスク指示: 「APIモックの重装備は不要」)。CLI 全体の
// ネットワーク込み動作確認は M45 の実演(bot作成PR)で行う。
// ---------------------------------------------------------------------------

import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildAppJwt, pickInstallation } from "../../scripts/bot-token.mjs";

function decodeSegment(segment: string): string {
  return Buffer.from(segment, "base64url").toString("utf8");
}

function makeRsaKeyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function splitJwt(jwt: string): { headerSeg: string; payloadSeg: string; signatureSeg: string } {
  const parts = jwt.split(".");
  const headerSeg = parts[0];
  const payloadSeg = parts[1];
  const signatureSeg = parts[2];
  if (headerSeg === undefined || payloadSeg === undefined || signatureSeg === undefined) {
    throw new Error(`JWT の形が不正です: ${jwt}`);
  }
  return { headerSeg, payloadSeg, signatureSeg };
}

describe("buildAppJwt", () => {
  it("header/payload が GitHub App JWT の形を満たす(iat=now-60・exp=now+540)", () => {
    const { privateKey } = makeRsaKeyPair();
    const now = 1_700_000_000;
    const jwt = buildAppJwt(4415558, privateKey, now);
    const { headerSeg, payloadSeg } = splitJwt(jwt);

    const header: unknown = JSON.parse(decodeSegment(headerSeg));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(decodeSegment(payloadSeg)) as {
      iss: number;
      iat: number;
      exp: number;
    };
    expect(payload.iss).toBe(4415558);
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 9 * 60);
    // GitHub の上限(exp は「現在時刻」から10分=600秒以内)を超えていないこと。
    expect(payload.exp - now).toBeLessThanOrEqual(600);
  });

  it("appId が文字列でも iss は数値化される", () => {
    const { privateKey } = makeRsaKeyPair();
    const jwt = buildAppJwt("4415558", privateKey, 1_700_000_000);
    const { payloadSeg } = splitJwt(jwt);
    const payload = JSON.parse(decodeSegment(payloadSeg)) as { iss: number };
    expect(payload.iss).toBe(4415558);
  });

  it("対応する公開鍵で署名検証に成功する", () => {
    const { privateKey, publicKey } = makeRsaKeyPair();
    const jwt = buildAppJwt(4415558, privateKey, 1_700_000_000);
    const { headerSeg, payloadSeg, signatureSeg } = splitJwt(jwt);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSeg}.${payloadSeg}`);
    expect(verifier.verify(publicKey, signatureSeg, "base64url")).toBe(true);
  });

  it("別の鍵ペアの公開鍵では署名検証に失敗する", () => {
    const { privateKey } = makeRsaKeyPair();
    const { publicKey: otherPublicKey } = makeRsaKeyPair();
    const jwt = buildAppJwt(4415558, privateKey, 1_700_000_000);
    const { headerSeg, payloadSeg, signatureSeg } = splitJwt(jwt);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSeg}.${payloadSeg}`);
    expect(verifier.verify(otherPublicKey, signatureSeg, "base64url")).toBe(false);
  });

  it("nowSeconds を省略しても呼び出せる(既定値=実行時刻)", () => {
    const { privateKey } = makeRsaKeyPair();
    const jwt = buildAppJwt(4415558, privateKey);
    expect(jwt.split(".")).toHaveLength(3);
  });
});

describe("pickInstallation", () => {
  it("インストールが0件なら例外を投げる", () => {
    expect(() => pickInstallation([], "BelkaDolphin")).toThrow(/1件も見つかりません/);
  });

  it("インストールが1件ならownerを問わずそれを返す", () => {
    const installation = { id: 1, account: { login: "SomeoneElse" } };
    expect(pickInstallation([installation], "BelkaDolphin")).toBe(installation);
  });

  it("複数件でownerに一致する1件があればそれを返す(大文字小文字を無視)", () => {
    const target = { id: 2, account: { login: "BelkaDolphin" } };
    const other = { id: 3, account: { login: "SomeoneElse" } };
    expect(pickInstallation([other, target], "belkadolphin")).toBe(target);
  });

  it("複数件でownerに一致する件が0件なら例外を投げる", () => {
    const a = { id: 4, account: { login: "A" } };
    const b = { id: 5, account: { login: "B" } };
    expect(() => pickInstallation([a, b], "BelkaDolphin")).toThrow(/絞り込めません/);
  });

  it("複数件でownerに一致する件が2件以上あれば例外を投げる", () => {
    const a = { id: 6, account: { login: "BelkaDolphin" } };
    const b = { id: 7, account: { login: "BelkaDolphin" } };
    expect(() => pickInstallation([a, b], "BelkaDolphin")).toThrow(/絞り込めません/);
  });
});
