import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import crypto from 'node:crypto'
import { expressify } from '@overleaf/promise-utils'
import PrepExtService, { PrepExtError } from './PrepExtService.mjs'

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function requirePrepExtApiToken(req, res, next) {
  const configuredToken = Settings.prepExt?.apiToken
  if (!configuredToken) {
    logger.error({}, 'Prep Ext API token is not configured')
    return res.status(500).send('Prep Ext API token is not configured')
  }

  const requestToken = req.get('x-prep-token')
  if (typeof requestToken !== 'string' || !secureEquals(requestToken, configuredToken)) {
    return res.sendStatus(401)
  }
  return next()
}

async function createManuscriptProject(req, res, next) {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : null
    const projectId = await PrepExtService.promises.createProjectFromToken(token)
    return res.status(200).json({ project_id: projectId.toString() })
  } catch (error) {
    if (error instanceof PrepExtError) {
      logger.warn({ err: error }, 'Prep Ext manuscript request rejected')
      return res.status(error.statusCode).send(error.message)
    }
    return next(error)
  }
}

export default {
  requirePrepExtApiToken,
  createManuscriptProject: expressify(createManuscriptProject),
}
