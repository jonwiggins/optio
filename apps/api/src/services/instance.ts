/**
 * Which API process this is (docs/plans/scale-out.md). Every API pod shares
 * one Postgres and one Redis; what tells them apart is this id: the holder
 * of a lease, the instance a run is attached to, the name in a log line.
 *
 * `OPTIO_INSTANCE_ID` names the pod (the chart sets it from the pod's name);
 * the process always appends a suffix of its own, so a restarted pod is a
 * new instance and nothing it held is mistaken for the old one's. Without
 * the env var the host name stands in for the pod name.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

const base = process.env.OPTIO_INSTANCE_ID?.trim() || hostname();
const suffix = randomBytes(3).toString("hex");

/** This process's id: `<pod or host name>:<6 hex, new at every boot>`. */
export const INSTANCE_ID: string = `${base}:${suffix}`;

/** When this process started. */
export const INSTANCE_STARTED_AT: Date = new Date();
