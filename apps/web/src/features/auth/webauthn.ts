function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = window.atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

function bufferToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

type PublicKeyCredentialWithResponse = PublicKeyCredential & {
  response: AuthenticatorAttestationResponse | AuthenticatorAssertionResponse
}

export function parseCreationOptions(options: PublicKeyCredentialCreationOptionsJSON) {
  return {
    rp: options.rp,
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    challenge: base64UrlToBuffer(options.challenge),
    attestation: options.attestation as AttestationConveyancePreference | undefined,
    user: {
      ...options.user,
      id: base64UrlToBuffer(options.user.id),
    },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: base64UrlToBuffer(credential.id),
      transports: credential.transports as AuthenticatorTransport[] | undefined,
      type: credential.type as PublicKeyCredentialType,
    })),
    authenticatorSelection: options.authenticatorSelection
      ? {
          ...options.authenticatorSelection,
          authenticatorAttachment: options.authenticatorSelection
            .authenticatorAttachment as AuthenticatorAttachment | undefined,
          residentKey: options.authenticatorSelection.residentKey as
            | ResidentKeyRequirement
            | undefined,
          userVerification: options.authenticatorSelection.userVerification as
            | UserVerificationRequirement
            | undefined,
        }
      : undefined,
  } satisfies PublicKeyCredentialCreationOptions
}

export function parseRequestOptions(options: PublicKeyCredentialRequestOptionsJSON) {
  return {
    rpId: options.rpId,
    timeout: options.timeout,
    challenge: base64UrlToBuffer(options.challenge),
    userVerification: options.userVerification as UserVerificationRequirement | undefined,
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: base64UrlToBuffer(credential.id),
      transports: credential.transports as AuthenticatorTransport[] | undefined,
      type: credential.type as PublicKeyCredentialType,
    })),
  } satisfies PublicKeyCredentialRequestOptions
}

export function serializeCredential(credential: Credential | null) {
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('Passkey was not returned by the browser')
  }
  const typedCredential = credential as PublicKeyCredentialWithResponse
  const response = typedCredential.response
  const payload: Record<string, unknown> = {
    id: typedCredential.id,
    rawId: bufferToBase64Url(typedCredential.rawId),
    type: typedCredential.type,
    response: {},
    clientExtensionResults: typedCredential.getClientExtensionResults(),
  }

  if (response instanceof AuthenticatorAttestationResponse) {
    payload.response = {
      attestationObject: bufferToBase64Url(response.attestationObject),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      transports: response.getTransports(),
    }
  } else if (response instanceof AuthenticatorAssertionResponse) {
    payload.response = {
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    }
  }

  return payload
}
