import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

/** The four SimpleWebAuthn calls we use, as an object so tests can script verification. */
export interface WebAuthn {
  genReg: typeof generateRegistrationOptions;
  verifyReg: typeof verifyRegistrationResponse;
  genAuth: typeof generateAuthenticationOptions;
  verifyAuth: typeof verifyAuthenticationResponse;
}

export const realWebAuthn: WebAuthn = {
  genReg: generateRegistrationOptions,
  verifyReg: verifyRegistrationResponse,
  genAuth: generateAuthenticationOptions,
  verifyAuth: verifyAuthenticationResponse,
};
