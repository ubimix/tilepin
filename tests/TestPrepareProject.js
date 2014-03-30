var expect = require('expect.js');
var TileSourceProvider = require('../tilepin-provider');
var $ = require('cheerio');
var _ = require('underscore');
var Path = require('path');
var Q = require('q');

describe('Tilepin DataSource provider', function() {

    var dir;
    var provider;
    beforeEach(function() {
        var path = './tests';
        dir = Path.resolve(process.cwd(), path);
        provider = new TileSourceProvider.TileMillProvider({
            dir : dir
        });
    });
    it('should load external files', function(done) {
        provider.loadTileSource({
            source : 'project'
        }).then(
                function(result) {
                    var dom = $(result.xml);
                    var fileElm = dom
                            .find('layer datasource parameter[name="file"]');
                    expect(fileElm[0]).not.to.be(null);

                    var expectedPath = Path.resolve(dir,
                            'project/layers/ne_110m_admin_0_countries/'
                                    + 'ne_110m_admin_0_countries.shp');
                    expect(fileElm.contents() + '').to.eql('<!--[CDATA['
                            + expectedPath + ']]-->');
                }).fin(function() {
            done();
        }).done();
    })
});
