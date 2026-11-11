/* eslint-disable no-undef */
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        extractBibTexAttachments tester
 * CVM-Role:        TESTING
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file tests a component of Zettlr.
 *
 * END HEADER
 */

import assert from "assert";
import extractBibTexAttachments from "../source/app/service-providers/citeproc/util/extract-bibtex-attachments";
import "mocha";

interface BibTexAttachments {
  [citekey: string]: string[] | false;
}

const validBibTexFile = `
% Encoding: UTF-8

@InProceedings{Szegedy2014a,
  author    = {Christian Szegedy and Wojciech Zaremba and Ilya Sutskever and Joan Bruna},
  title     = {Intriguing properties of neural networks},
  year      = {2014},
  file      = {:References_HE/0x04 Neural Networks, Machine Learning, General AI/Szegedy, Zaremba, Sutskever, Bruna, Erhan, Goodfellow, Fergus 2014 - Intriguing properties of neural networks.pdf:PDF},
  timestamp = {2019-12-07},
}

@Article{Javadnejad2019a,
  author    = {Farid Javadnejad and Daniel T. Gillins and Christopher E. Parrish and Richard K. Slocum},
  title     = {{A} photogrammetric approach to fusing natural colour and thermal infrared {UAS} imagery in {3D} point cloud generation},
  journal   = {International Journal of Remote Sensing},
  year      = {2019},
  month     = jul,
  doi       = {10.1080/01431161.2019.1641241},
  file      = {:References_HE/0x02 Sensors and Sensor Analysis/Javadnejad, Gillins, Parrish, Slocum 2019 - A photogrammetric approach to fusing natural colour and thermal infrared UAS imagery in 3D point cloud generation.pdf:PDF;:References_HE/Weblinks.md:md},
  timestamp = {2020-01-10},
}

@Article{NoFiles2020,
  author    = {Author Name},
  title     = {{S}ome {T}itle},
  journal   = {A Journal Name},
  timestamp = {2020-01-10},
}

@Comment{jabref-meta: databaseType:bibtex;}
`;

const validResults: BibTexAttachments = {
  Szegedy2014a: [
    "References_HE/0x04 Neural Networks, Machine Learning, General AI/Szegedy, Zaremba, Sutskever, Bruna, Erhan, Goodfellow, Fergus 2014 - Intriguing properties of neural networks.pdf",
  ],
  Javadnejad2019a: [
    "References_HE/0x02 Sensors and Sensor Analysis/Javadnejad, Gillins, Parrish, Slocum 2019 - A photogrammetric approach to fusing natural colour and thermal infrared UAS imagery in 3D point cloud generation.pdf",
    "References_HE/Weblinks.md",
  ],
  NoFiles2020: false,
};

const invalidBibTexFile = `
% Encoding: UTF-8

@InProceedingsSzegedy2014a,
  author    Christian Szegedy and Wojciech Zaremba and Ilya Sutskever and Joan Bruna},
  title     = {Intriguing properties of neural networks},
  year      = {2014},
  file      = {:References_HE/0x04 Neural Networks, Machine Learning, General AI/Szegedy, Zaremba, Sutskever, Bruna, Erhan, Goodfellow, Fergus 2014 - Intriguing properties of neural networks.pdf:PDF},
  timestamp = {2019-12-07},
}

@Comment{jabref-meta: databaseType:bibtex;}
`;

// Zotero writes each attachment as `title:path:type` and puts a backslash
// before each `\`, `:` and `;` of a part. The entries and their paths are
// test cases of Zotero's own BibTeX translator
// (https://github.com/zotero/translators/blob/master/BibTeX.js).
const zoteroBibTexFile = String.raw`
@article{zoteroFilePath1,
    title = {Zotero: single attachment},
    file = {Test:files/47/test2.pdf:application/pdf}
}

@article{zoteroFilePaths2,
    title = {Zotero: multiple attachments},
    file = {Test1:files/47/test2.pdf:application/pdf;Test2:files/46/test2-min.pdf:application/pdf}
}

@article{zoteroFilePaths4,
    title = {Zotero: linked attachments},
    file = {Test:E\:\\some\\random\\folder\\test2.pdf:application/pdf}
}
`;

const zoteroResults: BibTexAttachments = {
  zoteroFilePath1: ["files/47/test2.pdf"],
  zoteroFilePaths2: ["files/47/test2.pdf", "files/46/test2-min.pdf"],
  zoteroFilePaths4: [String.raw`E:\some\random\folder\test2.pdf`],
};

// An attachment title that holds both separators, after a snapshot.
const separatorsInTitleFile = String.raw`
@article{Nik80,
  title = {Integral symmetric bilinear forms and some of their applications},
  file = {Snapshot:/srv/zotero/storage/CD34/page.html:text/html;Full Text (Lattices\: forms, groups\; a survey):/srv/zotero/storage/AB12/Nikulin - 1980 - Forms.pdf:application/pdf},
}
`;

describe("Utility#extractBibTexAttachments()", function () {
  it("reads the attachment records that Zotero writes", function () {
    assert.deepStrictEqual(extractBibTexAttachments(zoteroBibTexFile, ""), zoteroResults);
  });

  it("gives the files of an attachment whose title holds a separator, PDF first", function () {
    assert.deepStrictEqual(extractBibTexAttachments(separatorsInTitleFile, "/srv/library"), {
      Nik80: [
        "/srv/zotero/storage/AB12/Nikulin - 1980 - Forms.pdf",
        "/srv/zotero/storage/CD34/page.html",
      ],
    });
  });

  it("should successfully parse a valid BibTex file", function () {
    const files = extractBibTexAttachments(validBibTexFile, "");
    assert.deepStrictEqual(
      Object.keys(files),
      Object.keys(validResults),
      "The parsed results do not contain the same keys!",
    );
    for (const key in files) {
      assert.deepStrictEqual(
        files[key],
        validResults[key],
        `Key ${key} differs from the expected result!`,
      );
    }
  });

  it("should throw an error due to invalid BibTex entries", function () {
    assert.throws(() => {
      extractBibTexAttachments(invalidBibTexFile, "");
    });
  });
});
