import { NextResponse } from "next/server";

export function GET() {
  const serviceDid = process.env.KITES_SERVICE_DID;
  const publicKeyMultibase = process.env.KITES_SERVICE_PUBLIC_KEY_MULTIBASE;

  if (!serviceDid || !publicKeyMultibase) {
    return NextResponse.json(
      { error: "Service identity is not configured" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: serviceDid,
    verificationMethod: [
      {
        id: `${serviceDid}#atproto`,
        type: "Multikey",
        controller: serviceDid,
        publicKeyMultibase,
      },
    ],
    service: [
      {
        id: "#bsky_notif",
        type: "BskyNotificationService",
        serviceEndpoint: "https://kites.social",
      },
    ],
  });
}
