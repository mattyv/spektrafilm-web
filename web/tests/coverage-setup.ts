import { rm } from "node:fs/promises";

export default async function setup() {
  await rm("coverage/e2e-raw", { recursive: true, force: true });
}
