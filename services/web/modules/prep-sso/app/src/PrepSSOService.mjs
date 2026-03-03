import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import { jwtVerify, importSPKI } from 'jose'
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'
import EmailHelper from '../../../../app/src/Features/Helpers/EmailHelper.mjs'
import ThirdPartyIdentityManager from '../../../../app/src/Features/User/ThirdPartyIdentityManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserCreator from '../../../../app/src/Features/User/UserCreator.mjs'
import { User } from '../../../../app/src/models/User.mjs'

const PREP_PROVIDER_ID = 'prep'
const replayClient = RedisWrapper.client('web')

class PrepSSOError extends Error {
  constructor(message, statusCode = 403) {
    super(message)
    this.name = 'PrepSSOError'
    this.statusCode = statusCode
  }
}

let publicKeyPromise

function getPrepSSOConfig() {
  if (!Settings.prepSso?.enabled) {
    throw new PrepSSOError('Prep SSO is disabled', 404)
  }
  if (!Settings.prepSso.startUrl) {
    throw new PrepSSOError('Prep SSO start URL is not configured', 500)
  }
  if (!Settings.prepSso.publicKey) {
    throw new PrepSSOError('Prep SSO public key is not configured', 500)
  }
  return Settings.prepSso
}

async function getPublicKey() {
  if (!publicKeyPromise) {
    const { publicKey } = getPrepSSOConfig()
    const normalizedPublicKey = publicKey.replace(/\\n/g, '\n').trim()
    publicKeyPromise = importSPKI(normalizedPublicKey, 'RS256')
  }
  return publicKeyPromise
}

function toIdentity(payload) {
  const email = EmailHelper.parseEmail(payload.email)
  if (!payload.sub || !email || !payload.jti || typeof payload.exp !== 'number') {
    throw new PrepSSOError('Prep SSO token is missing required claims')
  }

  return {
    externalUserId: payload.sub.toString(),
    email,
    emailVerified: payload.email_verified === true,
    firstName: typeof payload.first_name === 'string' ? payload.first_name : '',
    lastName: typeof payload.last_name === 'string' ? payload.last_name : '',
    jti: payload.jti.toString(),
    exp: payload.exp,
  }
}

async function markTokenAsUsed(identity) {
  const ttlSeconds = Math.max(1, identity.exp - Math.floor(Date.now() / 1000))
  const replayKey = `prep-sso:jti:${identity.jti}`
  const ok = await replayClient.set(replayKey, '1', 'EX', ttlSeconds, 'NX')
  if (ok !== 'OK') {
    throw new PrepSSOError('Prep SSO token has already been used')
  }
}

async function verifyBridgeToken(token) {
  if (!token || typeof token !== 'string') {
    throw new PrepSSOError('Prep SSO token is missing')
  }

  try {
    const prepSso = getPrepSSOConfig()
    const publicKey = await getPublicKey()
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: prepSso.issuer,
      audience: prepSso.audience,
      algorithms: ['RS256'],
    })

    return toIdentity(payload)
  } catch (error) {
    if (error instanceof PrepSSOError) {
      throw error
    }
    throw new PrepSSOError('Prep SSO token could not be verified')
  }
}

async function consumeBridgeToken(token) {
  const identity = await verifyBridgeToken(token)
  await markTokenAsUsed(identity)
  return identity
}

async function syncUserDetails(user, identity) {
  if (!Settings.prepSso?.syncUserDetailsOnLogin) {
    return user
  }

  const updates = {}
  if (identity.firstName && identity.firstName !== user.first_name) {
    updates.first_name = identity.firstName
  }
  if (identity.lastName && identity.lastName !== user.last_name) {
    updates.last_name = identity.lastName
  }

  if (Object.keys(updates).length === 0) {
    return user
  }

  return await User.findByIdAndUpdate(user._id, { $set: updates }, { new: true }).exec()
}

async function findLinkedUser(identity) {
  try {
    return await ThirdPartyIdentityManager.promises.getUser(
      PREP_PROVIDER_ID,
      identity.externalUserId
    )
  } catch (error) {
    if (error.name === 'ThirdPartyUserNotFoundError') {
      return null
    }
    throw error
  }
}

async function linkUser(user, identity, auditLog) {
  const normalizedAuditLog = {
    ...auditLog,
    initiatorId: user._id,
  }

  return await ThirdPartyIdentityManager.promises.link(
    user._id,
    PREP_PROVIDER_ID,
    identity.externalUserId,
    {
      email: identity.email,
      emailVerified: identity.emailVerified,
      firstName: identity.firstName,
      lastName: identity.lastName,
    },
    normalizedAuditLog
  )
}

async function createUser(identity) {
  if (!identity.emailVerified) {
    throw new PrepSSOError(
      'Prep user email must be verified before creating an Overleaf account',
      403
    )
  }

  return await UserCreator.promises.createNewUser(
    {
      email: identity.email,
      first_name: identity.firstName,
      last_name: identity.lastName,
      holdingAccount: false,
    },
    {}
  )
}

async function findOrCreateUser(identity, auditLog) {
  let user = await findLinkedUser(identity)
  if (user) {
    user = await syncUserDetails(user, identity)
    return { user, isNewUser: false }
  }

  user = identity.emailVerified
    ? await UserGetter.promises.getUserByAnyEmail(identity.email)
    : null

  if (!user) {
    user = await createUser(identity)
    const linkedUser = await linkUser(user, identity, auditLog)
    return { user: linkedUser, isNewUser: true }
  }

  const linkedUser = await linkUser(user, identity, auditLog)
  user = await syncUserDetails(linkedUser, identity)
  return { user, isNewUser: false }
}

function buildStartUrl(returnTo) {
  const prepSso = getPrepSSOConfig()
  const url = new URL(prepSso.startUrl)
  if (returnTo) {
    url.searchParams.set('return_to', returnTo)
  }
  return url.toString()
}

function makePrepSampleKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

const PrepSSOService = {
  PREP_PROVIDER_ID,
  buildStartUrl,
  consumeBridgeToken,
  findOrCreateUser,
  makePrepSampleKeyPair,
  verifyBridgeToken,
}

export { PrepSSOError }
export default {
  ...PrepSSOService,
  promises: PrepSSOService,
}
