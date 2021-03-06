import ENTRY from "../constant/entry.js"
import ENV from "../constant/env.js"
import SOURCE_TYPE from "../constant/source-type.js"

import Compiler from "../caching-compiler.js"
import Entry from "../entry.js"
import Module from "../module.js"
import Package from "../package.js"
import { REPLServer } from "repl"
import Runtime from "../runtime.js"
import Wrapper from "../wrapper.js"

import acornInternalAcorn from "../acorn/internal/acorn.js"
import acornInternalWalk from "../acorn/internal/walk.js"
import assign from "../util/assign.js"
import binding from "../binding.js"
import builtinEntries from "../builtin-entries.js"
import call from "../util/call.js"
import captureStackTrace from "../error/capture-stack-trace.js"
import clone from "../module/clone.js"
import getCacheName from "../util/get-cache-name.js"
import isError from "../util/is-error.js"
import isStackTraceMasked from "../util/is-stack-trace-masked.js"
import makeRequireFunction from "../module/make-require-function.js"
import maskFunction from "../util/mask-function.js"
import maskStackTrace from "../error/mask-stack-trace.js"
import realRequire from "../real/require.js"
import rootModule from "../root-module.js"
import setGetter from "../util/set-getter.js"
import setSetter from "../util/set-setter.js"
import shared from "../shared.js"
import validateESM from "../module/esm/validate.js"
import wrap from "../util/wrap.js"

const {
  STATE_EXECUTION_STARTED,
  STATE_PARSING_STARTED,
  TYPE_ESM
} = ENTRY

const {
 CHECK,
 EVAL,
 REPL
} = ENV

const {
  MODULE,
  UNAMBIGUOUS
} = SOURCE_TYPE

const ExObject = __external__.Object

function hook(vm) {
  let entry

  const pkg = Package.get("")

  function managerWrapper(manager, func, args) {
    const wrapped = Wrapper.find(vm, "createScript", pkg.range)

    return Reflect.apply(wrapped, this, [manager, func, args])
  }

  function methodWrapper(manager, func, args) {
    let [content, scriptOptions] = args
    scriptOptions = assign({ __proto__: null }, scriptOptions)

    if (! scriptOptions.produceCachedData) {
      scriptOptions.produceCachedData = true
    }

    entry.cacheName = getCacheName(entry, content)

    let compileData = entry.package.cache.compile[entry.cacheName]

    if (compileData) {
      if (compileData.scriptData &&
          scriptOptions.produceCachedData &&
          ! Reflect.has(scriptOptions, "cachedData")) {
        scriptOptions.cachedData = compileData.scriptData
      }
    } else {
      compileData = tryWrapper(Compiler.compile, [
        entry,
        content,
        {
          pragmas: false,
          sourceType: UNAMBIGUOUS,
          strict: false,
          var: true,
          warnings: false
        }
      ])
    }

    entry.state = STATE_PARSING_STARTED

    if (entry.type === TYPE_ESM) {
      tryValidateESM(manager, entry, content)
    }

    entry.state = STATE_EXECUTION_STARTED

    const code =
      "(()=>{" +
        'var g=Function("return this")(),' +
        "m=g.module," +
        "e=m&&m.exports," +
        'k="' + entry.runtimeName + '";' +
        "if(e&&!g[k]){" +
          "m.exports=e.entry.exports;" +
          "require=e.entry.require;" +
          "e.entry.addBuiltinModules(g);" +
          "Reflect.defineProperty(g,k,{" +
            "__proto__:null," +
            "value:e" +
          "})" +
        "}" +
      "})();" +
      compileData.code

    const result = tryWrapper.call(vm, func, [code, scriptOptions], content)

    if (result.cachedDataProduced) {
      compileData.scriptData = result.cachedData
    }

    result.runInContext = createTryWrapper(result.runInContext, content)
    result.runInThisContext = createTryWrapper(result.runInThisContext, content)
    return result
  }

  function setupCheck() {
    const { Script } = vm

    vm.Script = maskFunction(function (code, options) {
      vm.Script = Script
      const { wrapper } = Module
      code = code.slice(wrapper[0].length, -wrapper[1].length)
      setupEntry(rootModule)
      return vm.createScript(code, options)
    }, Script)
  }

  function setupEntry(mod) {
    entry = Entry.get(mod)
    entry.addBuiltinModules = createAddBuiltinModules(entry)
    entry.package = pkg
    entry.require = makeRequireFunction(clone(mod))
    entry.runtimeName = shared.runtimeName

    Reflect.setPrototypeOf(mod, Module.prototype)
    Runtime.enable(entry, new ExObject)
  }

  function setupEval() {
    const { runInThisContext } = vm

    vm.runInThisContext = maskFunction(function (code, options) {
      vm.runInThisContext = runInThisContext
      setupEntry(shared.unsafeContext.module)
      return vm.createScript(code, options).runInThisContext(options)
    }, runInThisContext)
  }

  function setupREPL() {
    acornInternalAcorn.enable()
    acornInternalWalk.enable()

    const { createContext } = REPLServer.prototype

    if (rootModule.id === "<repl>") {
      setupEntry(rootModule)
    } else if (typeof createContext === "function") {
      REPLServer.prototype.createContext = maskFunction(function () {
        REPLServer.prototype.createContext = createContext
        const context = call(createContext, this)
        setupEntry(context.module)
        return context
      }, createContext)
    }

    const { support } = shared

    if (! support.inspectProxies) {
      return
    }

    const util = realRequire("util")
    const { inspect } = builtinEntries.util.module.exports

    // Defining a truthy, but non-function value, for `customInspectSymbol`
    // will inform builtin `inspect()` to bypass the deprecation warning for
    // the custom `util.inspect()` function when inspecting `util`.
    Reflect.defineProperty(util, shared.customInspectKey, {
      __proto__: null,
      configurable: true,
      value: true,
      writable: true
    })

    if (support.replShowProxy) {
      util.inspect = inspect
      return
    }

    const _inspect = util.inspect

    setGetter(util, "inspect", () => {
      util.inspect = inspect
      return _inspect
    })

    setSetter(util, "inspect", (value) => {
      Reflect.defineProperty(util, "inspect", {
        __proto__: null,
        configurable: true,
        enumerable: true,
        value,
        writable: true
      })
    })
  }

  Wrapper.manage(vm, "createScript", managerWrapper)
  Wrapper.wrap(vm, "createScript", methodWrapper)

  if (CHECK) {
    setupCheck()
  } else if (EVAL)  {
    setupEval()
  } else if (REPL) {
    setupREPL()
  }
}

function createAddBuiltinModules(entry) {
  const lazyModules = [
    "assert", "async_hooks", "buffer", "child_process", "cluster", "crypto",
    "dgram", "dns", "domain", "events", "fs", "http", "http2", "https", "net",
    "os", "path", "perf_hooks", "punycode", "querystring", "readline", "repl",
    "stream", "string_decoder", "tls", "tty", "url", "util", "v8", "vm", "zlib"
  ]

  if (typeof binding.inspector.open === "function") {
    lazyModules.push("inspector")
    lazyModules.sort()
  }

  return function addBuiltinModules(context) {
    const req = entry.require
    const exportedConsole = req("console")

    Reflect.defineProperty(context, "console", {
      __proto__: null,
      configurable: true,
      enumerable: true,
      get: () => exportedConsole
    })

    Reflect.defineProperty(context, "process", {
      __proto__: null,
      configurable: true,
      enumerable: true,
      value: req("process"),
      writable: true
    })

    for (const name of lazyModules) {
      const set = (value) => {
        Reflect.defineProperty(context, name, {
          __proto__: null,
          configurable: true,
          enumerable: true,
          value,
          writable: true
        })
      }

      Reflect.defineProperty(context, name, {
        __proto__: null,
        configurable: true,
        get() {
          context[name] = void 0

          const exported = req(name)

          Reflect.defineProperty(context, name, {
            __proto__: null,
            configurable: true,
            get: () => exported,
            set
          })

          return exported
        },
        set
      })
    }
  }
}

function createTryWrapper(func, content) {
  return wrap(func, function (func, args) {
    return tryWrapper.call(this, func, args, content)
  })
}

function tryValidateESM(caller, entry, content) {
  let error

  try {
    return validateESM(entry)
  } catch (e) {
    error = e
  }

  if (! isError(error) ||
      isStackTraceMasked(error)) {
    throw error
  }

  captureStackTrace(error, caller)
  throw maskStackTrace(error, content, null, true)
}

function tryWrapper(func, args, content) {
  let error

  try {
    return Reflect.apply(func, this, args)
  } catch (e) {
    error = e
  }

  if (! isError(error) ||
      isStackTraceMasked(error)) {
    throw error
  }

  const isESM = error.sourceType === MODULE

  Reflect.deleteProperty(error, "sourceType")
  throw maskStackTrace(error, content, null, isESM)
}

export default hook
