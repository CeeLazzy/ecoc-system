const https = require("https");

const urls = [
    "https://172.16.3.2:7019/SkylimsService/Parallel/HorizonService.svc?wsdl",
    "https://172.16.3.2:7019/SkylimsService/parallel/HorizonService.svc?wsdl",
    "https://172.16.3.2:7019/SkylimsService/Parallel/HorizonService.svc?singleWsdl",
    "https://172.16.3.2:7019/SkylimsService/parallel/HorizonService.svc?singleWsdl",
    "https://172.16.3.2:7019/SkylimsService/parallel/HorizonService.svc/mex"
];

const agent = new https.Agent({
    rejectUnauthorized: false
});

function fetchUrl(url) {
    return new Promise(resolve => {
        https.get(url, { agent }, res => {
            let body = "";

            res.on("data", chunk => {
                body += chunk.toString();
            });

            res.on("end", () => {
                resolve({
                    url,
                    status: res.statusCode,
                    contentType: res.headers["content-type"],
                    preview: body.slice(0, 800)
                });
            });
        }).on("error", err => {
            resolve({
                url,
                error: err.message
            });
        });
    });
}

async function test() {
    for (const url of urls) {
        const result = await fetchUrl(url);

        console.log("\n==============================");
        console.log(result.url);

        if (result.error) {
            console.log("ERROR:", result.error);
            continue;
        }

        console.log("STATUS:", result.status);
        console.log("CONTENT-TYPE:", result.contentType);
        console.log("PREVIEW:");
        console.log(result.preview);
    }
}

test();