import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import request from 'request'
import { promisifyMultiResult } from '@overleaf/promise-utils'
import PrepExtService from './PrepExtService.mjs'

const prepRequest = request.defaults({
  json: true,
  timeout: 5000,
})
const prepRequestAsync = promisifyMultiResult(prepRequest, ['response', 'body'])

async function prepExtEvent(event) {
  if (!Settings.prepExt?.enabled) {
    return
  }

  const projectId = event?.projectId?.toString?.() ?? event?.projectId
  if (typeof projectId !== 'string') {
    logger.warn({ event }, 'Prep Ext event missing projectId')
    return
  }

  try {
    const manuscript =
      await PrepExtService.promises.getManuscriptProjectById(projectId)

    const headers = {}
    if (Settings.prepExt?.apiToken) {
      headers['x-prep-token'] = Settings.prepExt.apiToken
    }

    const { response, body } = await prepRequestAsync({
      method: 'PUT',
      url: `${Settings.prepExt?.apiUrl}/overleaf/project/${projectId}`,
      headers,
      body: manuscript,
    })

    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      logger.warn(
        {
          projectId,
          statusCode: response?.statusCode,
          body,
        },
        'Prep Ext project sync failed'
      )
      return
    }

    logger.debug({ projectId }, 'Prep Ext project sync succeeded')
  } catch (err) {
    logger.warn({ err, event }, 'Prep Ext project sync error')
  }
}

const PrepExtHooks = {
  prepExtEvent,
}

export default {
  promises: PrepExtHooks,
}
