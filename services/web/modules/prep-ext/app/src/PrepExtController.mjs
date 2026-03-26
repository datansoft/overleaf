import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { expressify } from '@overleaf/promise-utils'
import multer from 'multer'
import PrepExtService, { PrepExtError } from './PrepExtService.mjs'

const prepUpload = multer({
  dest: Settings.path.uploadFolder,
  limits: {
    fileSize: Settings.maxUploadSize,
  },
})

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

function createManuscriptFileMiddleware(req, res, next) {
  return prepUpload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(422).send('file too large')
    }
    if (err) {
      return next(err)
    }
    if (!req.file?.path) {
      return res.status(400).send('file is required')
    }
    return next()
  })
}

async function createManuscriptFile(req, res, next) {
  const uploadPath = req.file?.path
  try {
    const projectId =
      typeof req.params?.project_id === 'string' ? req.params.project_id : null
    const name = typeof req.body?.name === 'string' ? req.body.name : null
    const isRoot =
      req.body?.is_root === true ||
      req.body?.is_root === 'true' ||
      req.body?.is_root === 1 ||
      req.body?.is_root === '1'

    await PrepExtService.promises.createProjectFileByProjectId(
      projectId,
      {
        name,
        fsPath: uploadPath,
        isRoot,
      }
    )
    return res.sendStatus(201)
  } catch (error) {
    if (error instanceof PrepExtError) {
      logger.warn({ err: error }, 'Prep Ext manuscript file request rejected')
      return res.status(error.statusCode).send(error.message)
    }
    return next(error)
  } finally {
    if (uploadPath) {
      fs.unlink(uploadPath, () => {})
    }
  }
}

async function deleteManuscriptProject(req, res, next) {
  try {
    const projectId =
      typeof req.params?.project_id === 'string' ? req.params.project_id : null
    await PrepExtService.promises.deleteProjectById(projectId)
    return res.sendStatus(200)
  } catch (error) {
    if (error instanceof PrepExtError) {
      logger.warn({ err: error }, 'Prep Ext manuscript request rejected')
      return res.status(error.statusCode).send(error.message)
    }
    return next(error)
  }
}

async function syncManuscriptProjectMembers(req, res, next) {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : null
    const projectId =
      typeof req.params?.project_id === 'string' ? req.params.project_id : null
    const result = await PrepExtService.promises.syncProjectMembersByToken(
      projectId,
      token
    )
    return res.status(200).json(result)
  } catch (error) {
    if (error instanceof PrepExtError) {
      logger.warn({ err: error }, 'Prep Ext manuscript member sync request rejected')
      return res.status(error.statusCode).send(error.message)
    }
    return next(error)
  }
}

export default {
  requirePrepExtApiToken,
  createManuscriptFileMiddleware,
  createManuscriptProject: expressify(createManuscriptProject),
  createManuscriptFile: expressify(createManuscriptFile),
  deleteManuscriptProject: expressify(deleteManuscriptProject),
  syncManuscriptProjectMembers: expressify(syncManuscriptProjectMembers),
}
