module.exports = () => {
    const buildStr = process.env.BUILD_NUMBER ? '.${env.BUILD_NUMBER}' : '';
    return {
        productName: "VTD-ERP Print server",
        nsis: {
            oneClick: false,
            artifactName: '${productName}-${version}' + buildStr + '-${os}-${arch}-Installer.${ext}',
        },
        artifactName: '${productName}-${version}' + buildStr + '-${os}-${arch}.${ext}',
        win: {
            "requestedExecutionLevel": "highestAvailable",
            target: [
                {
                    target: "portable",
                    arch: ['ia32', 'x64'],
                },
                {
                    target: "nsis",
                    arch: ['ia32', 'x64'],
                },
            ],
            extraResources: "./external/win32/${arch}",
        },
        "build": {
            "win": {
              "requestedExecutionLevel": "highestAvailable"
            }
          },
        linux: {
            target: [
                "tar.gz",
                "deb"
            ],
            category: "Printing",
        },
    };
};
