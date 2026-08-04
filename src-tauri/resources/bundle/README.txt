此目录用于存放离线 bundle（bundle.zip，由 scripts/package-bundle.ps1 生成）。
生成后运行 npm run tauri build，安装包将内置离线 bundle，所有用户无需联网即可编译。
bundle.zip 体积大不入 git 仓库。
