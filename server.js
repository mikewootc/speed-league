#!/usr/bin/env node
'use strict'

const http = require('http');
const httpProxy = require('http-proxy');
const url = require('url');

//
// Create a proxy server with custom application logic
//
var proxy = httpProxy.createProxyServer({});

//
// Create your custom server and just call `proxy.web()` to proxy
// a web request to the target passed in the options
// also you can use `proxy.ws()` to proxy a websockets request
//
var server = http.createServer(function(req, res) {
    try {
        proxy.on('error', (err) => {
            console.log('error', err);
        });

        // You can define here your custom logic to handle the request
        // and then proxy the request.
        let host = url.parse(req.url).hostname;
        //console.log('req url:', req.url);
        //console.log('req host:', host);
        console.log('req headers:', req.headers.range);
        //proxy.web(req, res, { target: 'http://127.0.0.1:5060' });
        //proxy.web(req, res, { target: 'http://127.0.0.1' });
        proxy.web(req, res, { target: 'http://' + host });

    } catch(err) {
        console.log('proxy err:', err);
    }
});

console.log("listening on port 9704")
server.listen(9704);


// vim:set tw=0:
