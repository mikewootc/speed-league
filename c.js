#!/usr/bin/env node
'use strict'

const EventEmitter = require('events');
const axios = require('axios');
const fs = require('fs');
const Logger = require('cpclog');
const md5File = require('md5-file');

//const logger = Logger.createWrapper('download', Logger.LEVEL_TRACE);
//const logger = Logger.createWrapper('download', Logger.LEVEL_DEBUG);
const logger = Logger.createWrapper('download', Logger.LEVEL_INFO);
 
//const LEAGUE_MEMBERS = ['127.0.0.1', '172.16.5.91', '10.10.5.2'];
const LEAGUE_MEMBERS = ['127.0.0.1', '172.16.5.91'];
const THREADS = LEAGUE_MEMBERS.length * 5;

let fileName = './d.html';
let exists = fs.existsSync(fileName);
if (exists) {
    logger.debug(Logger.BLUE_B, 'Remove old file');
    fs.unlinkSync(fileName);
}

class TaskDict extends EventEmitter {
    constructor() {
        super();
        this.dict = {};
        this.tasks = {};
    }

    release() {
        for (let id in this.tasks) {
            let task = this.tasks[id]
            if (task) {
                if (task.interval) {
                    clearInterval(task.interval);
                }
            }
        }
    }

    addItem(k, v) {
        this.dict[k] = v;
        this.touchTask(null, {type: 'addItem'});
    }

    removeItem(k) {
        delete this.dict[k];
        logger.trace(Logger.BLUE, 'TaskDict remove');
        this.touchTask(null, {type: 'removeItem'});
    }

    // taskFunc(event)
    //      event: {type: 'addItem' / 'removeItem' / 'interval'}
    addTask(id, taskFunc, intervalMs) {
        this.tasks[id] = {};
        this.tasks[id].interval = setInterval(() => {
            taskFunc({type: 'interval'});
        }, intervalMs);

        // on touch only this task
        this.on('touch_' + id, (event) => {
            taskFunc(event);
        });

        // on touch all this task
        this.on('touchAll', (event) => {
            taskFunc(event);
        });
    }

    touchTask(id, event) {
        if (id) {
            this.emit('touch_' + id, event);
        } else {
            this.emit('touchAll', event);
        }
    }

    removeTask(id) {
        let task = this.tasks[id]
        if (task) {
            if (task.interval) {
                clearInterval(task.interval);
            }
        }

        delete this.tasks[id];
    }

    getLength() {
        //console.log('keys:', Object.keys(this.dict));
        return Object.keys(this.dict).length;
    }
}

class Downloader {
    constructor(url, segmentBytes) {
        //super();
        this.segmentBytes = segmentBytes ? segmentBytes : 1024 * 512;
        this.requestingSegments = new TaskDict();
        this.requestPos = 0;
        this.fd;
        this.fileLen = 0;
        this.url = url;
        this.downloaded = 0;
        this.downloadedPre = 0;
        this.leagueIndex = 0;
        this.retryList = [];
        this.allSegmentsRequested = false; // 所有的分片都已经发出请求.
    }

    getLeagueMember() {
        let len = LEAGUE_MEMBERS.length;
        if (this.leagueIndex < len - 1) {
            this.leagueIndex++;
        } else {
            this.leagueIndex = 0;
        }

        return LEAGUE_MEMBERS[this.leagueIndex];
    }

    // 将要下载的片段位置(如果retryList中有, 则从retryList中取出, 否则下载下一个新片段)
    getRequestPos() {
        if (this.requestPos < this.fileLen) {
            const pos = this.requestPos;
            this.requestPos += this.segmentBytes;
            return pos;
        } else {
            if (this.retryList.length > 0) {
                logger.debug(Logger.MAGENTA, 'retry it');
                return this.retryList.shift();
            } else {
                logger.debug('No more segment to download');
                return -1;
            }
        }
    }

    addRetry(pos) {
        logger.debug(Logger.YELLOW, 'add retry', pos);
        this.retryList.push(pos);
    }

    async httpGetFileLength() {
        try {
            // GET request for remote image
            let res = await axios({
                method: 'head',
                url: this.url,
            });
            let len = parseInt(res.headers['content-length']);
            return len
        } catch(err) {
            logger.error('httpGetFileLength err');
            throw err;
        }
    }

    async httpDownloadSegment(startPos) {
        try {
            logger.trace('segment:', startPos, 'for', this.url);
            let res = await axios({
                method: 'get',
                url: this.url,
                responseType: 'arraybuffer',
                proxy: {
                    //host: '127.0.0.1',
                    host: this.getLeagueMember(),
                    port: 9704,
                },
                headers: {
                    'Range': 'bytes=' + startPos + '-' + (startPos + this.segmentBytes - 1),
                    'Connection': 'keep-alive',
                },
            });
            //logger.debug('res headers:', res.headers);
            return res.data;
        } catch(err) {
            throw err;
        }
    }

    async httpDownloadSegment2File(startPos) {
        try {
            this.requestingSegments.addItem(startPos, {});
            let buf = await this.httpDownloadSegment(startPos);
            this.requestingSegments.removeItem(startPos);
            if (this.fd) {
                fs.writeSync(this.fd, buf, 0, buf.length, startPos);
                this.downloaded += buf.length;
                if (this.segmentBytes != buf.length) {
                    if (startPos + this.segmentBytes >= this.fileLen) {
                        logger.debug(Logger.CYAN_B, 'Got last segment');
                    } else {
                        logger.warn('this.segmentBytes:', this.segmentBytes, ', buf.length:', buf.length);
                        throw new Error('SegmentSizeError');
                    }
                }
                logger.debug(Logger.GREEN, 'seg ok', startPos);
            }
        } catch(err) {
            logger.error(Logger.RED, 'e_httpDownloadSegment2File');
            this.requestingSegments.removeItem(startPos);
            this.addRetry(startPos);
        }
    }

    async httpDownloadFile(fileName) {
        logger.info('Getting file length...');
        let len = await this.httpGetFileLength(this.url);
        logger.info(Logger.BLUE_B, 'File length:', len);
        this.fileLen = len;

        logger.info('Creating file...');
        fs.writeFileSync(fileName, new Buffer(len));
        logger.info('File created.');
        //fs.writeFile('file', new Buffer(1024*1024*1024 - 1), function () { fs.appendFile('file', new Buffer(1), function () { console.log('all done') }) })

        let fd = fs.openSync(fileName, 'r+');
        logger.debug('fd:', fd);
        this.fd = fd;

        this.requestingSegments.addTask('1', ()=> {
            // Add requests.
            while (this.requestingSegments.getLength() < THREADS && this.allSegmentsRequested == false) {
                const pos = this.getRequestPos();
                if (pos >= 0) {
                    logger.debug('add thread for', pos);
                    this.httpDownloadSegment2File(pos);
                    //this.requestPos += this.segmentBytes;
                } else {
                    this.allSegmentsRequested = true;
                    break;
                }
            }

            // Check completion.
            if (this.downloaded >= this.fileLen) {
                logger.info(Logger.GREEN_B, 'Download completed. ^_^');
                this.requestingSegments.release();
                clearInterval(this.monitor);
                const hash = md5File.sync(fileName);
                logger.info('md5:', hash);
            }
        }, 100);

        // Speed monitor
        this.monitor = setInterval(() => {
            // Calculate speed
            let oneSecondDownloaded = Math.floor((this.downloaded - this.downloadedPre) / 5);
            let strSpeed;
            if (oneSecondDownloaded >= 1024 * 1024) {
                //strSpeed = '' + Math.floor(oneSecondDownloaded / (1024 * 1024)) + 'MB';
                strSpeed = '' + Math.floor(oneSecondDownloaded / (1024 * 1024) * 10) / 10 + 'MB';
            } else if (oneSecondDownloaded >= 1024) {
                strSpeed = '' + Math.floor(oneSecondDownloaded / 1024) + 'KB';
            } else {
                strSpeed = '' + oneSecondDownloaded + 'B';
            }
            logger.info(`speed: ${strSpeed}\t, downloaded: ${this.downloaded}, total: ${this.fileLen}, ${this.requestingSegments.getLength()}`);

            this.downloadedPre = this.downloaded;
        }, 5000);
    }
}


setTimeout(async () => {
    //let d = new Downloader('http://127.0.0.1/index.html');
    //let d = new Downloader('http://172.16.5.105/netboot.tar.gz');
    //let d = new Downloader('http://releases.ubuntu.com/14.04/ubuntu-14.04.5-server-amd64.iso');
    let d = new Downloader('http://archive.ubuntu.com/ubuntu/dists/bionic/main/installer-amd64/current/images/netboot/netboot.tar.gz');

    try {
        await d.httpDownloadFile(fileName);
    } catch(err) {
        logger.error(err);
    }
}, 200);


// vim:set tw=0:
