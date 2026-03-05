import Settings from '@overleaf/settings'
import PrepExtController from './PrepExtController.mjs'

export default {
  apply(_webRouter, privateApiRouter) {
    if (!Settings.prepExt?.enabled) {
      return
    }

    privateApiRouter.post(
      '/prep/manuscript',
      PrepExtController.requirePrepExtApiToken,
      PrepExtController.createManuscriptProject
    )
  },
}
