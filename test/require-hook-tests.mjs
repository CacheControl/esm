import assert from "assert"
import fs from "fs-extra"
import zlib from "zlib"

if (! fs.pathExistsSync("./fixture/options/gz/index.mjs.gz")) {
  const content = fs.readFileSync("./fixture/options/js/index.js")
  const gzipped = zlib.gzipSync(content)
  fs.writeFileSync("./fixture/options/gz/index.mjs.gz", gzipped)
}

beforeEach(() => {
  delete global.this
})

describe("require hook", () => {
  it("should create an ESM loader", () =>
    import("./require/loader.mjs")
      .then((ns) => ns.default())
      .catch((e) => assert.ifError(e))
  )

  it("should support `options.sourceMap`", () =>
    import("./require/source-map.mjs")
      .then((ns) => ns.default())
      .catch((e) => assert.ifError(e))
  )

  it("should support creating multiple loaders with different options", (done) => {
    import("./require/mixed.mjs")
      .then((ns) => ns.default(done))
      .catch((e) => assert.ifError(e))
  })
})
