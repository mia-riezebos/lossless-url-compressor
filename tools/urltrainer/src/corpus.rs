use crate::public_suffix::PublicSuffixList;
use serde::{Deserialize, Serialize};
use url::Url;

pub const LINK_CLASS_COUNT: usize = 11;
pub const LINK_PRESENTATION_COUNT: usize = 5;
pub const TRAINING_CLASS_COUNT: usize = LINK_CLASS_COUNT * LINK_PRESENTATION_COUNT;

#[derive(Copy, Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Dataset {
    CommonCrawl,
    DiscordUnveiled,
    Disco,
    TgArchive,
    TelegramGroupverse,
    WhatsappPublicGroups,
    Generic,
}

impl Dataset {
    pub const ALL: [Self; 7] = [
        Self::CommonCrawl,
        Self::DiscordUnveiled,
        Self::Disco,
        Self::TgArchive,
        Self::TelegramGroupverse,
        Self::WhatsappPublicGroups,
        Self::Generic,
    ];

    pub fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|dataset| *dataset == self)
            .unwrap()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::CommonCrawl => "commoncrawl",
            Self::DiscordUnveiled => "discord-unveiled",
            Self::Disco => "disco",
            Self::TgArchive => "tgdataset",
            Self::TelegramGroupverse => "telegram-groupverse",
            Self::WhatsappPublicGroups => "whatsapp-public-groups",
            Self::Generic => "generic",
        }
    }

    pub fn family(self) -> &'static str {
        match self {
            Self::CommonCrawl => "commoncrawl",
            Self::DiscordUnveiled | Self::Disco => "discord",
            Self::TgArchive | Self::TelegramGroupverse => "telegram",
            Self::WhatsappPublicGroups => "whatsapp",
            Self::Generic => "generic",
        }
    }
}

pub const DATASET_COUNT: usize = Dataset::ALL.len();
pub const TRAINING_SIGNAL_COUNT: usize = DATASET_COUNT * TRAINING_CLASS_COUNT;

#[derive(Copy, Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkClass {
    Internal,
    DirectoryExternal,
    SocialPost,
    SocialProfile,
    ForumPost,
    Forum,
    Video,
    BlogNews,
    Web,
    Message,
    ForwardedMessage,
}

impl LinkClass {
    pub const ALL: [Self; LINK_CLASS_COUNT] = [
        Self::Internal,
        Self::DirectoryExternal,
        Self::SocialPost,
        Self::SocialProfile,
        Self::ForumPost,
        Self::Forum,
        Self::Video,
        Self::BlogNews,
        Self::Web,
        Self::Message,
        Self::ForwardedMessage,
    ];

    pub fn index(self) -> usize {
        match self {
            Self::Internal => 0,
            Self::DirectoryExternal => 1,
            Self::SocialPost => 2,
            Self::SocialProfile => 3,
            Self::ForumPost => 4,
            Self::Forum => 5,
            Self::Video => 6,
            Self::BlogNews => 7,
            Self::Web => 8,
            Self::Message => 9,
            Self::ForwardedMessage => 10,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Internal => "internal",
            Self::DirectoryExternal => "directory-external",
            Self::SocialPost => "social-post",
            Self::SocialProfile => "social-profile",
            Self::ForumPost => "forum-post",
            Self::Forum => "forum",
            Self::Video => "video",
            Self::BlogNews => "blog-news",
            Self::Web => "web",
            Self::Message => "message",
            Self::ForwardedMessage => "forwarded-message",
        }
    }

    pub fn default_weight(self) -> u64 {
        match self {
            Self::Internal => 1,
            Self::DirectoryExternal => 2,
            Self::SocialPost => 32,
            Self::SocialProfile => 24,
            Self::ForumPost => 20,
            Self::Forum | Self::Video => 12,
            Self::BlogNews => 8,
            Self::Web => 4,
            Self::Message => 40,
            Self::ForwardedMessage => 16,
        }
    }
}

#[derive(Copy, Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkPresentation {
    VisibleUrl,
    RedirectedUrl,
    SubmittedUrl,
    Masked,
    MissingText,
}

impl LinkPresentation {
    pub const ALL: [Self; LINK_PRESENTATION_COUNT] = [
        Self::VisibleUrl,
        Self::RedirectedUrl,
        Self::SubmittedUrl,
        Self::Masked,
        Self::MissingText,
    ];

    pub fn index(self) -> usize {
        match self {
            Self::VisibleUrl => 0,
            Self::RedirectedUrl => 1,
            Self::SubmittedUrl => 2,
            Self::Masked => 3,
            Self::MissingText => 4,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::VisibleUrl => "visible-url",
            Self::RedirectedUrl => "redirected-url",
            Self::SubmittedUrl => "submitted-url",
            Self::Masked => "masked",
            Self::MissingText => "missing-text",
        }
    }

    pub fn default_weight(self) -> u64 {
        match self {
            Self::VisibleUrl | Self::RedirectedUrl => 1,
            Self::SubmittedUrl => 2,
            Self::Masked | Self::MissingText => 0,
        }
    }
}

pub type ClassCounts = Vec<u64>;

pub fn empty_class_counts() -> ClassCounts {
    vec![0; TRAINING_CLASS_COUNT]
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingUrl {
    pub url: String,
    pub hostname: String,
    pub suffix: String,
    pub registrable_domain: String,
    pub has_www: bool,
    pub dataset: Dataset,
    pub link_class: LinkClass,
    pub link_presentation: LinkPresentation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_registrable_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_href: Option<String>,
    #[serde(skip)]
    pub analysis_weight: u64,
}

impl TrainingUrl {
    pub fn from_absolute(
        raw_url: &str,
        link_class: LinkClass,
        suffixes: &PublicSuffixList,
    ) -> Option<Self> {
        let parsed = Url::parse(raw_url).ok()?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return None;
        }
        let identity = suffixes.identity(parsed.host_str()?)?;
        Some(Self {
            url: raw_url.to_string(),
            hostname: identity.hostname,
            suffix: identity.suffix,
            registrable_domain: identity.registrable_domain,
            has_www: identity.has_www,
            dataset: Dataset::Generic,
            link_class,
            link_presentation: LinkPresentation::VisibleUrl,
            source_url: None,
            source_hostname: None,
            source_registrable_domain: None,
            display_text: None,
            link_href: None,
            analysis_weight: link_class.default_weight()
                * LinkPresentation::VisibleUrl.default_weight(),
        })
    }

    pub fn from_unweighted(raw_url: &str, suffixes: &PublicSuffixList) -> Option<Self> {
        let mut record = Self::from_absolute(raw_url, LinkClass::Web, suffixes)?;
        record.analysis_weight = 1;
        Some(record)
    }

    pub fn training_class_index(&self) -> usize {
        training_class_index(self.link_class, self.link_presentation)
    }

    pub fn training_signal_index(&self) -> usize {
        self.dataset.index() * TRAINING_CLASS_COUNT + self.training_class_index()
    }
}

pub fn training_class_index(class: LinkClass, presentation: LinkPresentation) -> usize {
    class.index() * LINK_PRESENTATION_COUNT + presentation.index()
}

pub fn training_class_names() -> Vec<String> {
    LinkClass::ALL
        .into_iter()
        .flat_map(|class| {
            LinkPresentation::ALL
                .into_iter()
                .map(move |presentation| format!("{}/{}", class.as_str(), presentation.as_str()))
        })
        .collect()
}

pub fn training_class_default_weights() -> Vec<u64> {
    LinkClass::ALL
        .into_iter()
        .flat_map(|class| {
            LinkPresentation::ALL
                .into_iter()
                .map(move |presentation| class.default_weight() * presentation.default_weight())
        })
        .collect()
}

pub fn dataset_names() -> Vec<&'static str> {
    Dataset::ALL.into_iter().map(Dataset::as_str).collect()
}

pub fn dataset_families() -> Vec<&'static str> {
    Dataset::ALL.into_iter().map(Dataset::family).collect()
}

#[cfg(test)]
mod tests {
    use super::TrainingUrl;
    use crate::public_suffix::PublicSuffixList;

    #[test]
    fn rejects_invalid_dns_hosts_before_training() {
        let suffixes = PublicSuffixList::from_text("com\nuk\nco.uk\nexample\n");
        let invalid = [
            "https://$2koutube.com/watch?v=x",
            "https://${app_name}.herokuapp.com/a",
            "https://${url.slice(megaphoneindex)}/a",
            "https://(.*)/a",
            "https://(bz-plus.ru/a",
            "https://***********.com/a",
            "https://**youtube.com/a",
            "https://youtube**.com/a",
            "https://under_score.example.com/a",
            "https://-leading.example.com/a",
            "https://trailing-.example.com/a",
        ];

        for url in invalid {
            assert!(
                TrainingUrl::from_unweighted(url, &suffixes).is_none(),
                "accepted invalid hostname from {url}"
            );
        }

        for url in [
            "https://youtube.com/watch?v=x",
            "https://foo-bar.example.co.uk/a",
            "https://xn--bcher-kva.example/a",
        ] {
            assert!(
                TrainingUrl::from_unweighted(url, &suffixes).is_some(),
                "rejected valid hostname from {url}"
            );
        }
    }
}
