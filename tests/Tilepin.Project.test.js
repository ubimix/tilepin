var Tilepin = require('../lib/Tilepin.Project.js');
require('../lib/Tilepin.P');

var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');

var options = {
    dir : __dirname
};

describe('Tilepin.Project', function() {
    it('should be able to load a project configuration', suite(function() {
        var projectDir = Path.join(__dirname,
                'projects/01-simple-tilemill-project');
        var projectFile = Path.join(projectDir, 'project.mml');
        var project = new Tilepin.Project({
            projectDir : projectDir,
            projectFile : projectFile
        });
        var prevConfig;
        expect(project).not.to.be(null);
        return project.loadProjectConfig().then(function(mml) {
            expect(mml).not.to.be(null);
            expect(_.isArray(mml.Layer)).to.be(true);
            expect(mml.Layer.length).to.be(1);
            var datasource = mml.Layer[0].Datasource;
            expect(datasource).not.to.be(null);
            var expectedFile = 'layers/country-shapes-110m/' //
                    + 'd0c530d7-ne_110m_admin_0_countries.shp';
            expectedFile = Path.join(projectDir, expectedFile);
            expect(datasource.file).to.eql(expectedFile);
            prevConfig = mml;
        })
        // When we getting again configuration of the same project without
        // re-loading it should return the same configuration instance.
        .then(function() {
            return project.loadProjectConfig().then(function(mml) {
                expect(mml).to.be(prevConfig);
            })
        })
        // Project should return a new configuration instance when the reload
        // flag is true.
        .then(function() {
            return project.loadProjectConfig(true).then(function(mml) {
                expect(mml).not.to.be(prevConfig);
            })
        });
    }));

    it('should be able to load configurations with dynamic styles',
            suite(function() {
                var projectDir = Path.join(__dirname,
                        'projects/02-project-with-jsstyles');
                var project = new Tilepin.Project({
                    projectDir : projectDir,
                    projectFile : Path.join(projectDir, 'project.mml')
                });
                return project.loadProjectConfig().then(function(mml) {
                    var stylesheets = mml.Stylesheet;
                    expect(stylesheets).not.to.be(null);
                    expect(stylesheets.length).to.be(1);
                    var path = Path.join(projectDir, 'expected.style');
                    var expectedStyle = FS.readFileSync(path, 'UTF-8');
                    var a = JSON.stringify(stylesheets[0].data, null, 2);
                    var b = JSON.stringify(expectedStyle, null, 2);
                    expect(a).to.eql(b);
                });
            }));

    it('should be able to generate a Mapnik XML file', suite(function() {
        var projectDir = Path.join(__dirname,
                'projects/02-project-with-jsstyles');
        var project = new Tilepin.Project({
            projectDir : projectDir,
            projectFile : Path.join(projectDir, 'project.mml')
        });
        var params = {};
        return project.loadAndCompileConfig(params).then(
                function(xml) {
                    expect(xml).not.to.be(null);
                    var str = '<?xml version="1.0" encoding="utf-8"?>';
                    expect(xml.indexOf(str) == 0).to.be(true);

                    var path = Path.join(projectDir, '' + //
                    'layers/country-shapes-110m/' + //
                    'd0c530d7-ne_110m_admin_0_countries.shp');
                    var str = '<Parameter name="file"><![CDATA[' + path
                            + ']]></Parameter>'
                    expect(xml.indexOf(str) > 0).to.be(true);
                    console.log(xml);
                });
    }));

})

function suite(test) {
    return function(done) {
        return Tilepin.P().then(test).then(done, function(err) {
            done(err);
        }).done();
    }
}