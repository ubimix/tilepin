var expect = require('expect.js');
var Tilepin = require('../tilepin');
var $ = require('cheerio');
var _ = require('underscore');
var Q = require('q');
var FS = require('fs');
var Path = require('path');

describe('Tilepin.CachingTilesProvider, ' + 'Tilepin.DispatchingTilesProvider '
        + 'and Tilepin.ProjectBasedTilesProvider', function() {
    it('should generate image tiles', function(done) {
        var dir = __dirname;
        var baseProvider = new Tilepin.ProjectBasedTilesProvider({
            dir : dir
        });
        var provider = new Tilepin.CachingTilesProvider({
            provider : new Tilepin.DispatchingTilesProvider({
                _provider : baseProvider,
                getProvider : function(params) {
                    return Q(baseProvider);
                }
            })
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
                format : 'tile'
            });
        }).then(function(info) {
            var file = Path.resolve(dir, './expected/expected-tile-1-0-0.png');
            return Q.ninvoke(FS, 'readFile', file).then(function(buf) {
                var first = info.tile.toString('hex');
                var second = buf.toString('hex');
                expect(first).to.eql(second);
            })
        }).fin(done).done();
    });

});
