var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');
var ProjectLoader = require('../tilepin-loader');
var ProjectManager = require('../tilepin-provider');
var P = require('../tilepin-commons').P;
var TilesProvider = require('../tilepin').TilesProvider;

var projectsDir = Path.join(__dirname, 'projects');
var options = {
    dir : projectsDir
};

function getHash(buf) {
    return require('crypto').createHash('sha1').update(buf).digest('hex')
}

function toString(obj) {
    return JSON.stringify(obj, null, 2);
}

describe('TilesProvider', function() {
    var provider;
    beforeEach(function() {
        provider = new TilesProvider(options);
    });

    it('should create PNG tiles', function(done) {
        provider.loadTile({
            source : 'project-01',
            format : 'png',
            z : 1,
            x : 0,
            y : 0,
        }).then(
                function(info) {
                    var file = Path.resolve(__dirname,
                            './expected/expected-tile-1-0-0.png');
                    return P.ninvoke(FS, 'readFile', file).then(function(buf) {
                        var first = getHash(info.tile);
                        var second = getHash(buf);
                        expect(first).to.eql(second);
                    })
                }).fin(done).done();
    })

    it('should generate UTFGrid tiles', function(done) {
        provider.loadTile({
            source : 'project-01',
            format : 'grid.json',
            z : 1,
            x : 0,
            y : 0,
        }).then(
                function(info) {
                    var file = Path.resolve(__dirname,
                            './expected/expected-tile-1-0-0.grid.json');
                    // return P.ninvoke(FS, 'writeFile', file,
                    // toString(info.tile), 'UTF-8');
                    return P.ninvoke(FS, 'readFile', file, 'UTF-8').then(
                            function(buf) {
                                var first = toString(info.tile);
                                expect(first).to.eql(buf);
                            })
                }).fin(done).done();
    })
});