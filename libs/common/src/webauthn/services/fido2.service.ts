import { CBOR } from "cbor-redux";

import { Utils } from "../../misc/utils";
import { CipherService } from "../../vault/abstractions/cipher.service";
import { CipherType } from "../../vault/enums/cipher-type";
import { Cipher } from "../../vault/models/domain/cipher";
import { CipherView } from "../../vault/models/view/cipher.view";
import { Fido2UserInterfaceService } from "../abstractions/fido2-user-interface.service.abstraction";
import { Fido2Utils } from "../abstractions/fido2-utils";
import {
  CredentialAssertParams,
  CredentialAssertResult,
  CredentialRegistrationParams,
  CredentialRegistrationResult,
  Fido2Service as Fido2ServiceAbstraction,
  NoCredentialFoundError,
} from "../abstractions/fido2.service.abstraction";
import { Fido2KeyView } from "../models/view/fido2-key.view";

import { CredentialId } from "./credential-id";
import { joseToDer } from "./ecdsa-utils";

// We support self-signing, but Google won't accept it.
// TODO: Look into supporting self-signed packed format.
const STANDARD_ATTESTATION_FORMAT: "none" | "packed" = "none";
const DEFAULT_TIMEOUT = 120000;
const MIN_TIMEOUT = 30000;
const MAX_TIMEOUT = 600000;

interface BitCredential {
  credentialId: CredentialId;
  keyType: "ECDSA";
  keyCurve: "P-256";
  keyValue: CryptoKey;
  rpId: string;
  rpName: string;
  userHandle: Uint8Array;
  userName: string;
  origin: string;
}

const KeyUsages: KeyUsage[] = ["sign"];

export class Fido2Service implements Fido2ServiceAbstraction {
  constructor(
    private fido2UserInterfaceService: Fido2UserInterfaceService,
    private cipherService: CipherService
  ) {}

  async createCredential(
    params: CredentialRegistrationParams,
    abortController = new AbortController()
  ): Promise<CredentialRegistrationResult> {
    // Comment: Timeouts could potentially be implemented using decorators.
    // But since I try to use decorators a little as possible and only
    // for the most generic solutions, I'm gonne leave this as is untill peer review.
    const timeout = setAbortTimeout(abortController);

    const presence = await this.fido2UserInterfaceService.confirmNewCredential(
      {
        credentialName: params.rp.name,
        userName: params.user.displayName,
      },
      abortController
    );

    const attestationFormat = STANDARD_ATTESTATION_FORMAT;
    const encoder = new TextEncoder();

    const clientData = encoder.encode(
      JSON.stringify({
        type: "webauthn.create",
        challenge: params.challenge,
        origin: params.origin,
        crossOrigin: false,
      })
    );
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      true,
      KeyUsages
    );

    const credentialId = await this.saveCredential({
      keyType: "ECDSA",
      keyCurve: "P-256",
      keyValue: keyPair.privateKey,
      origin: params.origin,
      rpId: params.rp.id,
      rpName: params.rp.name,
      userHandle: Fido2Utils.stringToBuffer(params.user.id),
      userName: params.user.displayName,
    });

    const authData = await generateAuthData({
      rpId: params.rp.id,
      credentialId,
      userPresence: presence,
      userVerification: true, // TODO: Change to false
      keyPair,
    });

    const asn1Der_signature = await generateSignature({
      authData,
      clientData,
      privateKey: keyPair.privateKey,
    });

    const attestationObject = new Uint8Array(
      CBOR.encode({
        fmt: attestationFormat,
        attStmt:
          attestationFormat === "packed"
            ? {
                alg: -7,
                sig: asn1Der_signature,
              }
            : {},
        authData,
      })
    );

    clearTimeout(timeout);

    return {
      credentialId: Fido2Utils.bufferToString(credentialId.raw),
      clientDataJSON: Fido2Utils.bufferToString(clientData),
      attestationObject: Fido2Utils.bufferToString(attestationObject),
      authData: Fido2Utils.bufferToString(authData),
      publicKeyAlgorithm: -7,
      transports: ["nfc", "usb"],
    };
  }

  async assertCredential(
    params: CredentialAssertParams,
    abortController = new AbortController()
  ): Promise<CredentialAssertResult> {
    const timeout = setAbortTimeout(abortController);
    let credential: BitCredential | undefined;

    if (params.allowedCredentialIds && params.allowedCredentialIds.length > 0) {
      // We're looking for regular non-resident keys
      credential = await this.getCredential(params.allowedCredentialIds);

      if (credential === undefined) {
        throw new NoCredentialFoundError();
      }

      // TODO: Google doesn't work with this. Look into how we're supposed to check this
      // if (credential.origin !== params.origin) {
      //   throw new OriginMismatchError();
      // }

      await this.fido2UserInterfaceService.confirmCredential(
        credential.credentialId.encoded,
        abortController
      );
    } else {
      // We're looking for a resident key
      const credentials = await this.getCredentialsByRp(params.rpId);

      if (credentials.length === 0) {
        throw new NoCredentialFoundError();
      }

      const pickedId = await this.fido2UserInterfaceService.pickCredential(
        credentials.map((c) => c.credentialId.encoded),
        abortController
      );
      credential = credentials.find((c) => c.credentialId.encoded === pickedId);
    }

    const encoder = new TextEncoder();
    const clientData = encoder.encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge: params.challenge,
        origin: params.origin,
      })
    );

    const authData = await generateAuthData({
      credentialId: credential.credentialId,
      rpId: params.rpId,
      userPresence: true,
      userVerification: true, // TODO: Change to false!
    });

    const signature = await generateSignature({
      authData,
      clientData,
      privateKey: credential.keyValue,
    });

    clearTimeout(timeout);

    return {
      credentialId: credential.credentialId.encoded,
      clientDataJSON: Fido2Utils.bufferToString(clientData),
      authenticatorData: Fido2Utils.bufferToString(authData),
      signature: Fido2Utils.bufferToString(signature),
      userHandle: Fido2Utils.bufferToString(credential.userHandle),
    };
  }

  private async getCredential(allowedCredentialIds: string[]): Promise<BitCredential | undefined> {
    let cipher: Cipher | undefined;
    for (const allowedCredential of allowedCredentialIds) {
      cipher = await this.cipherService.get(allowedCredential);

      if (cipher?.deletedDate != undefined) {
        cipher = undefined;
      }

      if (cipher != undefined) {
        break;
      }
    }

    if (cipher == undefined) {
      return undefined;
    }

    const cipherView = await cipher.decrypt();
    return await mapCipherViewToBitCredential(cipherView);
  }

  private async saveCredential(
    credential: Omit<BitCredential, "credentialId">
  ): Promise<CredentialId> {
    const pcks8Key = await crypto.subtle.exportKey("pkcs8", credential.keyValue);

    const view = new CipherView();
    view.type = CipherType.Fido2Key;
    view.name = credential.rpName;

    view.fido2Key = new Fido2KeyView();
    view.fido2Key.origin = credential.origin;
    view.fido2Key.keyType = credential.keyType;
    view.fido2Key.keyCurve = credential.keyCurve;
    view.fido2Key.keyValue = Fido2Utils.bufferToString(pcks8Key);
    view.fido2Key.rpId = credential.rpId;
    view.fido2Key.rpName = credential.rpName;
    view.fido2Key.userHandle = Fido2Utils.bufferToString(credential.userHandle);
    view.fido2Key.userName = credential.userName;
    view.fido2Key.origin = credential.origin;

    const cipher = await this.cipherService.encrypt(view);
    await this.cipherService.createWithServer(cipher);

    // TODO: Cipher service modifies supplied object, we might wanna change that.
    return new CredentialId(cipher.id);
  }

  private async getCredentialsByRp(rpId: string): Promise<BitCredential[]> {
    const allCipherViews = await this.cipherService.getAllDecrypted();
    const cipherViews = allCipherViews.filter(
      (cv) => !cv.isDeleted && cv.type === CipherType.Fido2Key && cv.fido2Key?.rpId === rpId
    );

    return await Promise.all(cipherViews.map((view) => mapCipherViewToBitCredential(view)));
  }
}

interface AuthDataParams {
  rpId: string;
  credentialId: CredentialId;
  userPresence: boolean;
  userVerification: boolean;
  keyPair?: CryptoKeyPair;
}

async function mapCipherViewToBitCredential(cipherView: CipherView): Promise<BitCredential> {
  const keyBuffer = Fido2Utils.stringToBuffer(cipherView.fido2Key.keyValue);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    {
      name: cipherView.fido2Key.keyType,
      namedCurve: cipherView.fido2Key.keyCurve,
    },
    true,
    KeyUsages
  );

  return {
    credentialId: new CredentialId(cipherView.id),
    keyType: cipherView.fido2Key.keyType,
    keyCurve: cipherView.fido2Key.keyCurve,
    keyValue: privateKey,
    rpId: cipherView.fido2Key.rpId,
    rpName: cipherView.fido2Key.rpName,
    userHandle: Fido2Utils.stringToBuffer(cipherView.fido2Key.userHandle),
    userName: cipherView.fido2Key.userName,
    origin: cipherView.fido2Key.origin,
  };
}

async function generateAuthData(params: AuthDataParams) {
  const encoder = new TextEncoder();

  const authData: Array<number> = [];

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest({ name: "SHA-256" }, encoder.encode(params.rpId))
  );
  authData.push(...rpIdHash);

  const flags = authDataFlags({
    extensionData: false,
    attestationData: params.keyPair !== undefined,
    userVerification: params.userVerification,
    userPresence: params.userPresence,
  });
  authData.push(flags);

  // add 4 bytes of counter - we use time in epoch seconds as monotonic counter
  // TODO: Consider changing this to a cryptographically safe random number
  const now = new Date().getTime() / 1000;
  authData.push(
    ((now & 0xff000000) >> 24) & 0xff,
    ((now & 0x00ff0000) >> 16) & 0xff,
    ((now & 0x0000ff00) >> 8) & 0xff,
    now & 0x000000ff
  );

  // attestedCredentialData
  const attestedCredentialData: Array<number> = [];

  // Use 0 because we're self-signing at the moment
  const aaguid = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  attestedCredentialData.push(...aaguid);

  // credentialIdLength (2 bytes) and credential Id
  const rawId = params.credentialId.raw;
  const credentialIdLength = [(rawId.length - (rawId.length & 0xff)) / 256, rawId.length & 0xff];
  attestedCredentialData.push(...credentialIdLength);
  attestedCredentialData.push(...rawId);

  if (params.keyPair) {
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", params.keyPair.publicKey);
    // COSE format of the EC256 key
    const keyX = Utils.fromUrlB64ToArray(publicKeyJwk.x);
    const keyY = Utils.fromUrlB64ToArray(publicKeyJwk.y);

    // const credPublicKeyCOSE = {
    //   "1": 2, // kty
    //   "3": -7, // alg
    //   "-1": 1, // crv
    //   "-2": keyX,
    //   "-3": keyY,
    // };
    // const coseBytes = new Uint8Array(cbor.encode(credPublicKeyCOSE));

    // Can't get `cbor-redux` to encode in CTAP2 canonical CBOR. So we do it manually:
    const coseBytes = new Uint8Array(77);
    coseBytes.set([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20], 0);
    coseBytes.set(keyX, 10);
    coseBytes.set([0x22, 0x58, 0x20], 10 + 32);
    coseBytes.set(keyY, 10 + 32 + 3);

    // credential public key - convert to array from CBOR encoded COSE key
    attestedCredentialData.push(...coseBytes);

    authData.push(...attestedCredentialData);
  }

  return new Uint8Array(authData);
}

interface SignatureParams {
  authData: Uint8Array;
  clientData: Uint8Array;
  privateKey: CryptoKey;
}

async function generateSignature(params: SignatureParams) {
  const clientDataHash = await crypto.subtle.digest({ name: "SHA-256" }, params.clientData);
  const sigBase = new Uint8Array([...params.authData, ...new Uint8Array(clientDataHash)]);
  const p1336_signature = new Uint8Array(
    await window.crypto.subtle.sign(
      {
        name: "ECDSA",
        hash: { name: "SHA-256" },
      },
      params.privateKey,
      sigBase
    )
  );

  const asn1Der_signature = joseToDer(p1336_signature, "ES256");

  return asn1Der_signature;
}

interface Flags {
  extensionData: boolean;
  attestationData: boolean;
  userVerification: boolean;
  userPresence: boolean;
}

function authDataFlags(options: Flags): number {
  let flags = 0;

  if (options.extensionData) {
    flags |= 0b1000000;
  }

  if (options.attestationData) {
    flags |= 0b01000000;
  }

  if (options.userVerification) {
    flags |= 0b00000100;
  }

  if (options.userPresence) {
    flags |= 0b00000001;
  }

  return flags;
}

function setAbortTimeout(abortController: AbortController, timeout = DEFAULT_TIMEOUT): number {
  // TODO: Set different timeouts depending on `userVerification` value
  const clampedTimeout = Math.max(MIN_TIMEOUT, Math.min(timeout, MAX_TIMEOUT));
  return window.setTimeout(() => abortController.abort(), clampedTimeout);
}