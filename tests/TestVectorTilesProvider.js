var expect = require('expect.js');
var Tilepin = require('../tilepin');
var $ = require('cheerio');
var _ = require('underscore');
var Q = require('q');
var FS = require('fs');
var Path = require('path');

function getHash(buf) {
    return require('crypto').createHash('sha1').update(buf).digest('hex')
}
describe('Tilepin.ProjectBasedTilesProvider - vector tiles', function() {
    it('should generate image tiles', function(done) {
        var dir = __dirname;
        var provider = new Tilepin.ProjectBasedTilesProvider({
            dir : dir
        });
        var sourceKey = 'project';
        Q().then(function() {
            return provider.invalidate({
                source : sourceKey
            });
        }).then(function() {
            return provider.loadTile({
                source : sourceKey,
                x : 0,
                y : 0,
                z : 1,
                format : 'vtile'
            });
        }).then(function(info) {
            var file = Path.resolve(dir, './expected/vtiles/tile-1-0-0.vtile');
            return Q.ninvoke(FS, 'readFile', file).then(function(buf) {
                var first = getHash(info.tile);
                var second = getHash(buf);
                expect(first).to.eql(second);
            })
        }).fin(done).done();
    });

});
