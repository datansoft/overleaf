import PrepExtRouter from './app/src/PrepExtRouter.mjs'
import PrepExtHooks from './app/src/PrepExtHooks.mjs'

/** @import { WebModule } from "../../types/web-module" */

/** @type {WebModule} */
const PrepExtModule = {
  router: PrepExtRouter,
  hooks: PrepExtHooks,
}

export default PrepExtModule
