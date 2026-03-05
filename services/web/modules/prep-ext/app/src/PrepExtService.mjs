import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { jwtVerify, importSPKI } from 'jose'
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'
import EmailHelper from '../../../../app/src/Features/Helpers/EmailHelper.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import ProjectCreationHandler from '../../../../app/src/Features/Project/ProjectCreationHandler.mjs'
import ProjectEntityUpdateHandler from '../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'

const replayClient = RedisWrapper.client('web')

class PrepExtError extends Error {
  constructor(message, statusCode = 403) {
    super(message)
    this.name = 'PrepExtError'
    this.statusCode = statusCode
  }
}

let publicKeyPromise

function getPrepConfig() {
  if (!Settings.prepExt?.enabled) {
    throw new PrepExtError('Prep integration is disabled', 404)
  }
  if (!Settings.prepExt.publicKey) {
    throw new PrepExtError('Prep public key is not configured', 500)
  }
  return Settings.prepExt
}

async function getPublicKey() {
  if (!publicKeyPromise) {
    const { publicKey } = getPrepConfig()
    const normalizedPublicKey = publicKey.replace(/\\n/g, '\n').trim()
    publicKeyPromise = importSPKI(normalizedPublicKey, 'RS256')
  }
  return publicKeyPromise
}

function normalizeClaims(payload) {
  const email = EmailHelper.parseEmail(payload.email)
  const manuscriptPayload = payload.payload

  if (!email) {
    throw new PrepExtError('Invalid email claim', 403)
  }

  if (typeof manuscriptPayload !== 'object' || manuscriptPayload == null) {
    throw new PrepExtError('Missing payload claim', 400)
  }

  const { title, template, bib } = manuscriptPayload
  if (
    typeof title !== 'string' ||
    typeof template !== 'string' ||
    typeof bib !== 'string'
  ) {
    throw new PrepExtError('payload.title, payload.template, payload.bib are required', 400)
  }

  return {
    email,
    payload: {
      title,
      template,
      bib,
    },
    jti: typeof payload.jti === 'string' ? payload.jti : null,
    exp: typeof payload.exp === 'number' ? payload.exp : null,
  }
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    throw new PrepExtError('token is required', 400)
  }

  const prep = getPrepConfig()

  try {
    const publicKey = await getPublicKey()
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: prep.issuer,
      audience: prep.audience,
      algorithms: ['RS256'],
    })

    return normalizeClaims(payload)
  } catch (error) {
    if (error instanceof PrepExtError) {
      throw error
    }
    logger.warn(
      {
        err: {
          name: error?.name,
          message: error?.message,
          code: error?.code,
          claim: error?.claim,
          reason: error?.reason,
        },
        expectedIssuer: prep.issuer,
        expectedAudience: prep.audience,
      },
      'Prep token verify failed'
    )
    throw new PrepExtError('Prep token could not be verified', 403)
  }
}

async function markTokenAsUsed(claims) {
  if (!claims.jti || !claims.exp) {
    throw new PrepExtError('Prep token is missing jti or exp', 403)
  }

  const ttlSeconds = Math.max(1, claims.exp - Math.floor(Date.now() / 1000))
  const replayKey = `prep-ext:jti:${claims.jti}`
  const ok = await replayClient.set(replayKey, '1', 'EX', ttlSeconds, 'NX')
  if (ok !== 'OK') {
    throw new PrepExtError('Prep token has already been used', 403)
  }
}

function toLines(contents) {
  return contents.split('\n')
}

async function createProjectFromClaims(claims) {
  const user = await UserGetter.promises.getUserByAnyEmail(claims.email, {
    _id: 1,
  })

  if (!user?._id) {
    throw new PrepExtError('User not found for email', 403)
  }

  const { title, template, bib } = claims.payload

  try {
    const project = await ProjectCreationHandler.promises.createBlankProject(
      user._id,
      title
    )
    const rootFolderId = project.rootFolder[0]._id

    const { doc: mainDoc } = await ProjectEntityUpdateHandler.promises.addDoc(
      project._id,
      rootFolderId,
      'main.tex',
      toLines(template),
      user._id,
      'prep-ext'
    )

    await ProjectEntityUpdateHandler.promises.setRootDoc(project._id, mainDoc._id)

    await ProjectEntityUpdateHandler.promises.addDoc(
      project._id,
      rootFolderId,
      'main.bib',
      toLines(bib),
      user._id,
      'prep-ext'
    )

    return project._id
  } catch (error) {
    if (
      error instanceof Errors.InvalidNameError ||
      error instanceof Errors.InvalidError
    ) {
      throw new PrepExtError(error.message, 400)
    }
    throw error
  }
}

async function createProjectFromToken(token) {
  const claims = await verifyToken(token)
  await markTokenAsUsed(claims)
  return await createProjectFromClaims(claims)
}

const PrepExtService = {
  createProjectFromToken,
}

export { PrepExtError }
export default {
  ...PrepExtService,
  promises: PrepExtService,
}
