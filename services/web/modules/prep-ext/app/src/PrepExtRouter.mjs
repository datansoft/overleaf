import Settings from '@overleaf/settings'
import PrepExtController from './PrepExtController.mjs'
import PrepSSORouter from './PrepSSORouter.mjs'

export default {
  apply(webRouter, privateApiRouter) {
    if (!Settings.prepExt?.enabled) {
      return
    }

    PrepSSORouter.apply(webRouter)

    privateApiRouter.post(
      '/prep/manuscript',
      PrepExtController.requirePrepExtApiToken,
      PrepExtController.createManuscriptProject
    )
  },
}
