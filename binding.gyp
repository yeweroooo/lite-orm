{
  "targets": [
    {
      "target_name": "lite_orm",
      "sources": ["src/addon.cc"],
      "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
      "include_dirs": ["<!@(node -p \"require('node:path').dirname(process.execPath) + '/../include/node'\")"],
      "libraries": ["-lsqlite3"]
    }
  ]
}
