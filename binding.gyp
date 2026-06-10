{
  "targets": [
    {
      "target_name": "lite_orm",
      "sources": ["src/addon.cc", "deps/sqlite/sqlite3.c"],
      "defines": [
        "SQLITE_ENABLE_FTS5",
        "SQLITE_ENABLE_JSON1",
        "SQLITE_ENABLE_RTREE",
        "SQLITE_THREADSAFE=1"
      ],
      "include_dirs": [
        "deps/sqlite",
        "<!@(node -p \"require('node:path').dirname(process.execPath) + '/../include/node'\")"
      ],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }, {
          "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
          "cflags": ["-O2"]
        }]
      ]
    }
  ]
}
